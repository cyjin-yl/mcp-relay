/** Dependency-free, isolated Python helper. Requests are JSON on stdin, never shell arguments. */
export const PVE_HELPER = String.raw`
import base64, hashlib, json, os, re, signal, socket, stat, struct, subprocess, sys, tempfile, time, zlib

QMP_ROOT = "/run/qemu-server"
TEMP_ROOT = "/run"
PVESH = "/usr/bin/pvesh"
MAX_PNG = 12 * 1024 * 1024
MAX_RAW = 64 * 1024 * 1024
MAX_MESSAGE = 1024 * 1024
INPUT_ATTEMPTED = False

class Failure(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details

class QmpFailure(Failure):
    pass

def cancelled(signum, frame):
    raise Failure("cancelled", "PVE computer operation was cancelled.", mayHaveApplied=True)

signal.signal(signal.SIGTERM, cancelled)
signal.signal(signal.SIGINT, cancelled)

def remaining(deadline, maximum=3):
    value = deadline - time.monotonic()
    if value <= 0:
        raise Failure("timeout", "PVE computer operation exceeded its deadline.")
    return min(value, maximum)

def vm_id(value):
    if type(value) is not int or value < 100 or value > 999999999:
        raise Failure("invalid_vm_id", "A valid local PVE VMID is required.")
    return value

def process_identity(vmid):
    try:
        with open(os.path.join(QMP_ROOT, str(vmid) + ".pid")) as stream:
            raw_pid = stream.read(32).strip()
        if not re.fullmatch(r"[1-9][0-9]{0,9}", raw_pid):
            raise ValueError()
        pid = int(raw_pid)
        with open("/proc/" + str(pid) + "/stat") as stream:
            raw = stream.read(4096)
        ticks = raw[raw.rfind(")") + 2:].split()[19]
        with open("/proc/sys/kernel/random/boot_id") as stream:
            boot = stream.read(80).strip()
        return pid, "pve:%d:%d:%s:%s" % (vmid, pid, ticks, boot)
    except (FileNotFoundError, ProcessLookupError):
        raise Failure("vm_offline", "The selected VM is stopped or its QEMU process is unavailable.")
    except (ValueError, IndexError):
        raise Failure("vm_identity_invalid", "Could not verify the selected VM process identity.")

class QMP:
    def __init__(self, vmid, deadline, expected=None):
        self.vmid, self.deadline, self.sock = vm_id(vmid), deadline, None
        self.buffer, self.sequence = b"", 0
        self.pid, self.identity = process_identity(vmid)
        if expected is not None and expected != self.identity:
            raise Failure("vm_changed", "The VM restarted after observation. Capture a new frame.")
        path = os.path.join(QMP_ROOT, str(vmid) + ".qmp")
        info = os.stat(path, follow_symlinks=False)
        if not stat.S_ISSOCK(info.st_mode):
            raise Failure("qmp_unavailable", "The VM monitor is not a Unix socket.")
        self.socket_identity = (info.st_dev, info.st_ino)
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.settimeout(remaining(deadline))
            self.sock.connect(path)
            peer_pid, _, _ = struct.unpack("3i", self.sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            if peer_pid != self.pid:
                raise Failure("vm_changed", "The QMP peer does not match the observed VM process.")
            greeting = self.receive()
            if not isinstance(greeting.get("QMP"), dict):
                raise Failure("qmp_protocol_error", "The VM did not send a QMP greeting.")
            self.command("qmp_capabilities")
            self.verify()
        except BaseException:
            self.close()
            raise

    def close(self):
        if self.sock is not None:
            self.sock.close()
            self.sock = None

    def verify(self):
        _, current = process_identity(self.vmid)
        info = os.stat(os.path.join(QMP_ROOT, str(self.vmid) + ".qmp"), follow_symlinks=False)
        if current != self.identity or (info.st_dev, info.st_ino) != self.socket_identity:
            raise Failure("vm_changed", "The VM process or monitor changed. Capture a new frame.")

    def receive(self):
        while True:
            if b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if len(line) > MAX_MESSAGE:
                    raise Failure("qmp_protocol_error", "The VM returned an oversized QMP message.")
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeError):
                    raise Failure("qmp_protocol_error", "The VM returned malformed QMP JSON.")
                if not isinstance(value, dict):
                    raise Failure("qmp_protocol_error", "The VM returned an invalid QMP message.")
                return value
            if len(self.buffer) > MAX_MESSAGE:
                raise Failure("qmp_protocol_error", "The VM returned an oversized QMP message.")
            self.sock.settimeout(remaining(self.deadline, 120))
            chunk = self.sock.recv(65536)
            if not chunk:
                raise Failure("qmp_disconnected", "The VM monitor disconnected.", mayHaveApplied=True)
            self.buffer += chunk

    def command(self, execute, arguments=None):
        remaining(self.deadline)
        self.sequence += 1
        identifier = "relay-" + str(self.sequence)
        request = {"execute": execute, "id": identifier}
        if arguments is not None:
            request["arguments"] = arguments
        self.sock.settimeout(remaining(self.deadline))
        self.sock.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\r\n")
        while True:
            message = self.receive()
            if "event" in message or message.get("id") != identifier:
                continue
            if "error" in message:
                error = message["error"]
                description = str(error.get("desc", "QMP command rejected"))[:300] if isinstance(error, dict) else "QMP command rejected"
                raise QmpFailure("qmp_command_failed", description, command=execute)
            if "return" not in message:
                raise Failure("qmp_protocol_error", "The QMP reply has no result.")
            return message["return"]

def status(qmp):
    result = qmp.command("query-status")
    if not isinstance(result, dict) or not isinstance(result.get("status"), str):
        raise Failure("qmp_protocol_error", "Invalid VM status reply.")
    return result

def console(qmp):
    entries = qmp.command("qom-list", {"path": "/backend"})
    graphic = sorted((entry["name"] for entry in entries if isinstance(entry, dict)
        and re.fullmatch(r"console\[[0-9]+\]", str(entry.get("name", "")))
        and "graphic-console" in str(entry.get("type", ""))), key=lambda name: int(name[8:-1]))
    if not graphic:
        raise Failure("vm_no_graphical_console", "This VM has no live QEMU graphical console; passthrough-only and serial-only displays cannot be captured.")
    path = "/backend/" + graphic[0]
    device_path = qmp.command("qom-get", {"path": path, "property": "device"})
    head = qmp.command("qom-get", {"path": path, "property": "head"})
    if not isinstance(device_path, str) or len(device_path) > 1024 or type(head) is not int or head < 0:
        raise Failure("qmp_protocol_error", "Invalid graphical console identity.")
    # A console's QOM link is a canonical object path. screendump and input
    # routing instead require the qdev ID; passing the path is rejected by QEMU.
    match = re.fullmatch(r"/machine/peripheral/([A-Za-z0-9_.-]{1,128})", device_path)
    if match:
        device = match[1]
    else:
        try:
            device = qmp.command("qom-get", {"path": device_path, "property": "id"})
        except QmpFailure:
            device = None
    if not isinstance(device, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", device):
        raise Failure("vm_console_unaddressable", "The selected graphical console has no explicit QEMU device ID; implicit console routing is disabled.")
    return {"device": device, "devicePath": device_path, "head": head, "console": path}

def console_identity(qmp, target):
    digest = hashlib.sha256(json.dumps(target, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return qmp.identity + ":console:" + digest

def mice(qmp):
    result = qmp.command("query-mice")
    if not isinstance(result, list):
        raise Failure("qmp_protocol_error", "Invalid pointer capability reply.")
    return any(isinstance(mouse, dict) and mouse.get("current") is True and mouse.get("absolute") is True for mouse in result)

def dimensions(data):
    if len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise Failure("invalid_screenshot", "QEMU did not produce a PNG screenshot.")
    width, height = struct.unpack(">II", data[16:24])
    if width < 1 or height < 1 or width > 32768 or height > 32768 or width * height > 120000000:
        raise Failure("invalid_screenshot", "QEMU screenshot dimensions exceed supported limits.")
    return width, height

def ppm_to_png(data):
    offset, tokens = 0, []
    while len(tokens) < 4:
        while offset < len(data) and data[offset] in b" \r\n\t":
            offset += 1
        if offset < len(data) and data[offset] == 35:
            end = data.find(b"\n", offset)
            if end < 0:
                raise Failure("invalid_screenshot", "Truncated PPM screenshot header.")
            offset = end + 1
            continue
        match = re.match(rb"[^\s#]+", data[offset:])
        if match is None:
            raise Failure("invalid_screenshot", "Invalid PPM screenshot header.")
        tokens.append(match.group())
        offset += len(match.group())
    try:
        width, height, maximum = map(int, tokens[1:])
    except ValueError:
        raise Failure("invalid_screenshot", "Invalid PPM dimensions.")
    if tokens[0] != b"P6" or maximum != 255 or width < 1 or height < 1 or width > 32768 or height > 32768:
        raise Failure("invalid_screenshot", "Unsupported PPM screenshot format.")
    if offset >= len(data) or data[offset] not in b" \r\n\t":
        raise Failure("invalid_screenshot", "PPM screenshot has no pixel separator.")
    offset += 2 if data[offset:offset+2] == b"\r\n" else 1
    pixels = data[offset:]
    if len(pixels) != width * height * 3:
        raise Failure("invalid_screenshot", "PPM screenshot pixel length differs from its dimensions.")
    compressor, compressed = zlib.compressobj(6), bytearray()
    stride = width * 3
    for start in range(0, len(pixels), stride):
        compressed.extend(compressor.compress(b"\0" + pixels[start:start+stride]))
        if len(compressed) > MAX_PNG:
            raise Failure("screenshot_too_large", "Screenshot exceeds 12 MiB.")
    compressed.extend(compressor.flush())
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", bytes(compressed)) + chunk(b"IEND", b"")

def capture(qmp, target):
    # /tmp is often a small/full tmpfs on PVE. /run is root-owned and the
    # per-request directory is private. No caller-supplied path reaches QEMU.
    with tempfile.TemporaryDirectory(prefix="mcp-relay-pve-", dir=TEMP_ROOT) as directory:
        filename = os.path.join(directory, "frame")
        args = {"filename": filename, "device": target["device"], "head": target["head"], "format": "png"}
        try:
            qmp.command("screendump", args)
        except QmpFailure as error:
            if "format" not in str(error).lower():
                raise
            args.pop("format")
            qmp.command("screendump", args)
        info = os.stat(filename, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_RAW:
            raise Failure("screenshot_too_large", "QEMU screenshot exceeds its bounded capture size.")
        with open(filename, "rb") as stream:
            data = stream.read(MAX_RAW + 1)
        if len(data) > MAX_RAW:
            raise Failure("screenshot_too_large", "QEMU screenshot grew beyond its capture limit.")
        if not data.startswith(b"\x89PNG"):
            data = ppm_to_png(data)
        if len(data) > MAX_PNG:
            raise Failure("screenshot_too_large", "Screenshot exceeds 12 MiB.")
        width, height = dimensions(data)
        qmp.verify()
        return data, width, height

KEYS = set("ctrl ctrl_r alt alt_r shift shift_r meta_l meta_r ret esc tab backspace delete insert spc home end pgup pgdn up down left right caps_lock num_lock scroll_lock print pause minus equal bracket_left bracket_right backslash semicolon apostrophe comma dot slash grave_accent".split())
KEYS.update(chr(value) for value in range(97, 123))
KEYS.update(str(value) for value in range(10))
KEYS.update("f" + str(value) for value in range(1, 13))

def key_events(keys):
    if not isinstance(keys, list) or not 1 <= len(keys) <= 8 or len(set(keys)) != len(keys) or any(key not in KEYS for key in keys):
        raise Failure("unsupported_key", "Unsupported or duplicate QEMU key name.")
    return ([{"type": "key", "data": {"down": True, "key": {"type": "qcode", "data": key}}} for key in keys]
        + [{"type": "key", "data": {"down": False, "key": {"type": "qcode", "data": key}}} for key in reversed(keys)])

def text_keys(char):
    if "a" <= char <= "z" or "0" <= char <= "9":
        return [char]
    if "A" <= char <= "Z":
        return ["shift", char.lower()]
    plain = {" ": "spc", "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right", "\\": "backslash", ";": "semicolon", "'": "apostrophe", ",": "comma", ".": "dot", "/": "slash", "\x60": "grave_accent"}
    shifted = {"_": "minus", "+": "equal", "{": "bracket_left", "}": "bracket_right", "|": "backslash", ":": "semicolon", '"': "apostrophe", "<": "comma", ">": "dot", "?": "slash", "~": "grave_accent"}
    shifted.update(dict(zip("!@#$%^&*()", "1234567890")))
    if char in plain:
        return [plain[char]]
    if char in shifted:
        return ["shift", shifted[char]]
    raise Failure("unsupported_text", "PVE text input supports printable ASCII with a US guest keyboard layout; use explicit key actions for Enter/Tab.")

def send_events(qmp, target, events):
    global INPUT_ATTEMPTED
    qmp.verify()
    INPUT_ATTEMPTED = True
    qmp.command("input-send-event", {"events": events, "device": target["device"], "head": target["head"]})

def button_event(button, down):
    return {"type": "btn", "data": {"button": button, "down": down}}

def release_button(qmp, target, button):
    # Always bound this cleanup, including when cancellation interrupted a
    # request that originally had a long deadline. Node repeats the release
    # through a fresh helper before returning the held computer transaction.
    original_deadline = qmp.deadline
    try:
        qmp.deadline = time.monotonic() + 0.15
        send_events(qmp, target, [button_event(button, False)])
    except Exception:
        raise Failure("input_cleanup_failed", "QMP did not confirm release of the pointer button.", mayHaveApplied=True)
    finally:
        qmp.deadline = original_deadline

def point_events(x, y, width, height):
    if type(x) is not int or type(y) is not int or not 0 <= x < width or not 0 <= y < height:
        raise Failure("coordinate_out_of_bounds", "Coordinates must be inside the referenced VM screenshot.")
    return [{"type": "abs", "data": {"axis": "x", "value": round(x * 32767 / max(1, width - 1))}},
            {"type": "abs", "data": {"axis": "y", "value": round(y * 32767 / max(1, height - 1))}}]

def integer(value, low, high, code="invalid_arguments"):
    if type(value) is not int or not low <= value <= high:
        raise Failure(code, "PVE input parameter is outside its supported range.")
    return value

def perform(qmp, target, action, width, height, absolute):
    kind = action.get("type")
    if kind in ("move", "click", "drag", "scroll") and not absolute:
        raise Failure("absolute_pointer_unavailable", "The selected VM has no current absolute pointing device. Configure a tablet explicitly before coordinate input.")
    if kind == "move":
        send_events(qmp, target, point_events(action.get("x"), action.get("y"), width, height))
    elif kind == "click":
        button = action.get("button", "left")
        if button not in ("left", "middle", "right"):
            raise Failure("unsupported_button", "Unsupported pointer button.")
        point = point_events(action.get("x"), action.get("y"), width, height)
        for index in range(integer(action.get("clicks", 1), 1, 3)):
            # QEMU syncs pointer state once per request. A down/up pair in one
            # list is coalesced by USB tablets and never becomes a guest click.
            try:
                send_events(qmp, target, point + [button_event(button, True)])
            finally:
                release_button(qmp, target, button)
            if index + 1 < action.get("clicks", 1):
                time.sleep(min(0.08, remaining(qmp.deadline)))
    elif kind == "drag":
        start = point_events(action.get("fromX"), action.get("fromY"), width, height)
        point_events(action.get("toX"), action.get("toY"), width, height)
        duration = integer(action.get("durationMs", 400), 100, 5000) / 1000
        steps = max(2, min(100, round(duration / 0.02)))
        try:
            send_events(qmp, target, start + [button_event("left", True)])
            for index in range(1, steps + 1):
                time.sleep(min(duration / steps, remaining(qmp.deadline)))
                x = round(action["fromX"] + (action["toX"] - action["fromX"]) * index / steps)
                y = round(action["fromY"] + (action["toY"] - action["fromY"]) * index / steps)
                send_events(qmp, target, point_events(x, y, width, height))
        finally:
            release_button(qmp, target, "left")
    elif kind == "scroll":
        direction = action.get("direction")
        if direction not in ("up", "down"):
            raise Failure("unsupported_action", "PVE console scrolling supports only up and down; horizontal wheel events are not delivered by the standard QEMU tablet.")
        events = []
        if "x" in action or "y" in action:
            events.extend(point_events(action.get("x"), action.get("y"), width, height))
        for _ in range(integer(action.get("amount", 3), 1, 40)):
            events.extend([button_event("wheel-" + direction, True), button_event("wheel-" + direction, False)])
        send_events(qmp, target, events)
    elif kind == "key":
        send_events(qmp, target, key_events(action.get("keys")))
    elif kind == "text":
        text = action.get("text")
        if not isinstance(text, str) or len(text) > 16384 or any(not 32 <= ord(char) <= 126 for char in text):
            raise Failure("unsupported_text", "PVE text input accepts at most 16384 printable ASCII characters; Unicode and control characters are not supported.")
        # Validate the whole string before sending any input. Pair each key-up
        # in its same QMP request so helper cancellation cannot strand a key.
        chords = [text_keys(char) for char in text]
        for index, chord in enumerate(chords):
            send_events(qmp, target, key_events(chord))
            # QMP acknowledgement does not mean the guest drained its finite
            # keyboard queue. Pace text instead of flooding it at socket speed.
            if index + 1 < len(chords):
                time.sleep(min(0.01, remaining(qmp.deadline)))
    else:
        raise Failure("unsupported_action", "Unsupported PVE computer action.")

def inspect_vm(vmid, deadline, expected=None, include_image=False, do_action=None, release=None):
    expected_process = expected.split(":console:", 1)[0] if expected is not None else None
    qmp = QMP(vmid, deadline, expected_process)
    try:
        vm_status = status(qmp)
        target = console(qmp)
        identity = console_identity(qmp, target)
        if expected is not None and expected != identity:
            raise Failure("console_changed", "The selected graphical console changed after observation. Capture a new frame.")
        absolute = mice(qmp)
        if release is not None:
            if release not in ("left", "middle", "right"):
                raise Failure("unsupported_button", "Unsupported pointer release.")
            send_events(qmp, target, [button_event(release, False)])
            return {"ok": True, "released": True, "identity": identity}
        data, width, height = capture(qmp, target)
        result = {"ok": True, "vmid": vmid, "identity": identity, "status": vm_status["status"],
            "running": vm_status.get("running") is True and vm_status["status"] == "running", "absolutePointer": absolute,
            "width": width, "height": height, "capturedAt": round(time.time() * 1000), "console": target}
        if do_action is not None:
            if not result["running"]:
                raise Failure("vm_not_running", "The VM is not running; no input was sent.", status=result["status"])
            if do_action.get("width") != width or do_action.get("height") != height:
                raise Failure("display_changed", "VM display dimensions changed. Capture a fresh frame.")
            qmp.verify()
            perform(qmp, target, do_action["action"], width, height, absolute)
            result["inputSubmitted"] = True
        if include_image:
            result["pngBase64"] = base64.b64encode(data).decode("ascii")
        return result
    finally:
        qmp.close()

def inventory(deadline):
    result = subprocess.run([PVESH, "get", "/nodes/localhost/qemu", "--output-format", "json"],
        capture_output=True, timeout=remaining(deadline, 20), check=False)
    if result.returncode != 0:
        raise Failure("pve_inventory_failed", "Could not list the local PVE QEMU VMs. Root or non-interactive sudo access is required.")
    if len(result.stdout) > MAX_MESSAGE:
        raise Failure("pve_inventory_failed", "PVE inventory exceeds its supported response size.")
    values = json.loads(result.stdout)
    if not isinstance(values, list) or len(values) > 1024:
        raise Failure("pve_inventory_failed", "PVE returned an invalid local VM inventory.")
    output = []
    for value in values:
        remaining(deadline)
        vmid = vm_id(value.get("vmid"))
        item = {"vmid": vmid, "displayId": "pve:" + str(vmid), "name": str(value.get("name", "VM " + str(vmid)))[:512],
            "status": str(value.get("status", "unknown")), "graphicalConsole": "unknown", "inputAvailable": False, "qmpPermission": "unknown"}
        if item["status"] == "running":
            qmp = None
            try:
                qmp = QMP(vmid, min(deadline, time.monotonic() + 0.75))
                item["qmpPermission"] = "granted"
                current = status(qmp)
                item["status"] = current["status"]
                item["console"] = console(qmp)
                item["identity"] = console_identity(qmp, item["console"])
                item["graphicalConsole"] = "available"
                item["absolutePointer"] = mice(qmp)
                item["inputAvailable"] = current.get("running") is True and current["status"] == "running"
            except Failure as error:
                if error.code == "cancelled":
                    raise
                item["reason"] = str(error)
                if error.code == "vm_no_graphical_console":
                    item["graphicalConsole"] = "none"
            except PermissionError:
                item["qmpPermission"] = "denied"
                item["reason"] = "Permission to access this VM monitor was denied."
            except (OSError, ValueError):
                item["reason"] = "The VM monitor is unavailable or did not respond within the discovery budget."
            finally:
                if qmp is not None:
                    qmp.close()
        output.append(item)
    return {"ok": True, "virtualMachines": sorted(output, key=lambda item: item["vmid"])}

def main():
    raw = sys.stdin.buffer.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        raise Failure("invalid_arguments", "PVE helper request exceeds its input bound.")
    request = json.loads(raw)
    deadline = time.monotonic() + integer(request.get("timeoutMs"), 1, 120000) / 1000
    operation = request.get("operation")
    if operation == "inventory":
        return inventory(deadline)
    vmid = vm_id(request.get("vmid"))
    if operation not in ("inspect", "screenshot", "action", "release"):
        raise Failure("invalid_arguments", "Unknown PVE helper operation.")
    expected = request.get("expectedIdentity")
    if operation in ("action", "release") and (not isinstance(expected, str) or len(expected) > 200):
        raise Failure("vm_identity_invalid", "Input requires a frame-bound VM process identity.")
    return inspect_vm(vmid, deadline, expected, operation == "screenshot", request if operation == "action" else None,
        request.get("button", "left") if operation == "release" else None)

try:
    print(json.dumps(main(), separators=(",", ":")))
except Failure as error:
    error.details.setdefault("mayHaveApplied", INPUT_ATTEMPTED)
    print(json.dumps({"ok": False, "code": error.code, "message": str(error), "details": error.details}, separators=(",", ":")))
except PermissionError:
    print(json.dumps({"ok": False, "code": "pve_privilege_required", "message": "Root or non-interactive sudo permission is required to access local QEMU monitors."}))
except (TimeoutError, subprocess.TimeoutExpired):
    print(json.dumps({"ok": False, "code": "timeout", "message": "The PVE helper or VM monitor did not respond before its deadline."}))
except (FileNotFoundError, ConnectionRefusedError, ConnectionResetError):
    print(json.dumps({"ok": False, "code": "qmp_unavailable", "message": "The selected VM monitor is unavailable. Check the VM status and capture a new frame."}))
except Exception:
    print(json.dumps({"ok": False, "code": "pve_helper_failed", "message": "The PVE helper failed without confirming the operation."}))
`;
