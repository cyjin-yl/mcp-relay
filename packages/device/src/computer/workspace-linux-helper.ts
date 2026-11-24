/** Owned X11 server, input fence, and independent recovery guardian. */
export const linuxWorkspaceHelper = String.raw`#!/usr/bin/env python3
import base64, fcntl, hashlib, hmac, json, os, select, signal, socket, socketserver
import stat, subprocess, sys, threading, time, traceback
from pathlib import Path

# This branch runs in a fresh Python interpreter, never preexec_fn in the
# threaded guardian. No native resource or input command can start before GO.
if len(sys.argv) > 1 and sys.argv[1] == "--exec-child":
    import ctypes
    expected_parent, gate, kind = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
    config_path, name = Path(sys.argv[5]), sys.argv[6]
    argv = sys.argv[7:]
    if not argv: os._exit(125)
    if kind == "ephemeral":
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0: os._exit(125)
    # Check after PR_SET_PDEATHSIG: a parent that died before prctl must not
    # leave a short command alive. Persistent applications intentionally have
    # no parent-death signal after exec.
    if os.getppid() != expected_parent: os._exit(125)
    decision = os.read(gate, 1)
    os.close(gate)
    if decision != b"G" or os.getppid() != expected_parent: os._exit(125)
    if name != "viewer":
        config = json.loads(config_path.read_text())
        if (config_path.parent / "revoked.json").exists() or Path(config["revocationPath"]).exists():
            os._exit(125)
        if time.time()*1000 >= config["hardExpiresAt"]: os._exit(125)
    os.execvpe(argv[0], argv, os.environ)

CONFIG = Path(sys.argv[1])
C = json.loads(CONFIG.read_text())
ROOT = CONFIG.parent
RUNTIME = Path(C["runtimeDirectory"])
STATE = ROOT / "native-state.json"
NATIVE_LOCK = open(ROOT / "guardian.lock", "a+")
try: fcntl.flock(NATIVE_LOCK.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: sys.exit(2)
REVOKED = ROOT / "revoked.json"
def revoked():
    return REVOKED.exists() or Path(C["revocationPath"]).exists()
def revoke(reason):
    if not REVOKED.exists():
        fd = os.open(str(REVOKED), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump({"reason": reason}, f); f.flush(); os.fsync(f.fileno())
LOCK = threading.RLock()
EXEC_LOCK = threading.Lock()
STOP = threading.Event()
ACTIVE = None
RETURNING = False
CREATION_REVOKED = False
LAST_HEARTBEAT = time.monotonic()
HARD_MONO = LAST_HEARTBEAT + max(0, (C["hardExpiresAt"] - time.time()*1000)/1000)
EXPIRY_MONO = min(HARD_MONO, LAST_HEARTBEAT + max(0, (C["expiresAt"] - time.time()*1000)/1000))
S = {"schema": 1, "instanceId": C["instanceId"], "phase": "starting", "inputRevoked": False,
     "display": None, "resources": {}, "creationIntents": {}, "spawnProtocol": "pipe-go-v1",
     "recovery": None, "expiresAt": C["expiresAt"]}
PRIVATE = dict(C["environment"])
PHYSICAL = dict(C["environment"])
# Session configuration is private; host xpra.conf startup commands, listeners,
# clipboard and file-transfer preferences must not leak into this workspace.
for target in (PRIVATE, PHYSICAL):
    for key in ("XPRA_CONF_DIR", "XPRA_SYSTEM_CONF_DIRS", "XPRA_USER_CONF_DIRS", "XPRA_DEFAULT_CONF_DIRS"):
        target[key] = str(ROOT / "xpra-config")
(ROOT / "xpra-config").mkdir(mode=0o700, exist_ok=True)
LOG = open(ROOT / "native.log", "ab", buffering=0)

def save():
    with LOCK:
        temp = ROOT / ("native-state." + str(os.getpid()) + ".tmp")
        fd = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(S, f); f.flush(); os.fsync(f.fileno())
        os.replace(temp, STATE)
        directory_fd = os.open(str(ROOT), os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)

def identity(pid):
    try:
        text = Path("/proc/%d/stat" % pid).read_text()
        fields = text[text.rfind(")")+2:].split()
        if fields[0] == "Z": return None
        return {"pid": pid, "start": fields[19]}
    except (OSError, IndexError):
        return None

def matches(record):
    return bool(record) and identity(record["pid"]) == record

def spawn_owned(name, argv, env, ephemeral=False, pass_fds=(), stdin=None, stdout=None, stderr=None):
    # Persist the intent before fork. A missing committed identity means GO was
    # never sent; the wrapper receives EOF when the guardian dies and cannot
    # create an unrecorded X server, application, or input command.
    with LOCK:
        if name != "viewer" and (CREATION_REVOKED or revoked() or
                                S["phase"] != ("active" if ephemeral else "starting")):
            raise RuntimeError("creation_cancelled")
        intent = {"protocol": "pipe-go-v1", "stage": "prepared"}
        S.setdefault("creationIntents", {})[name] = intent
        if name == "app": S["appLaunchIntent"] = True
        save()
        rd, wr = os.pipe()
        p = None
        try:
            wrapper = [sys.executable, str(Path(__file__).resolve()), "--exec-child",
                       str(os.getpid()), str(rd), "ephemeral" if ephemeral else "persistent",
                       str(CONFIG), name] + argv
            p = subprocess.Popen(wrapper, env=env, stdin=stdin, stdout=stdout, stderr=stderr,
                                 close_fds=True, pass_fds=(rd,) + tuple(pass_fds), start_new_session=True)
            os.close(rd); rd = -1
            # relay-test-boundary: before-process-checkpoint
            record = identity(p.pid)
            if record is None: raise RuntimeError("native_process_exited:" + name)
            if ephemeral: S["activeCommand"] = record
            else: S["resources"][name] = record
            intent["stage"] = "committed"
            save()
            # relay-test-boundary: after-process-checkpoint
            if name != "viewer" and (CREATION_REVOKED or revoked()):
                raise RuntimeError("creation_cancelled")
            os.write(wr, b"G")
            return p
        finally:
            if rd >= 0: os.close(rd)
            os.close(wr)

def launch(name, argv, env, pass_fds=()):
    return spawn_owned(name, argv, env, pass_fds=pass_fds, stdin=subprocess.DEVNULL,
                       stdout=LOG, stderr=LOG)

def stop_record(record, immediate=False):
    if not matches(record): return True
    try: os.killpg(record["pid"], signal.SIGKILL if immediate else signal.SIGTERM)
    except ProcessLookupError: return True
    until = time.monotonic() + (2.0 if immediate else 1.0)
    while matches(record) and time.monotonic() < until: time.sleep(.02)
    if matches(record):
        try: os.killpg(record["pid"], signal.SIGKILL)
        except ProcessLookupError: pass
        until = time.monotonic() + 2
        while matches(record) and time.monotonic() < until: time.sleep(.02)
    return not matches(record)

def stop_owned(name):
    return stop_record(S["resources"].get(name))

def configure_private():
    for key in ("WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_ID", "DESKTOP_STARTUP_ID"):
        PRIVATE.pop(key, None)
    PRIVATE["XDG_SESSION_TYPE"] = "x11"
    PRIVATE["XAUTHORITY"] = str(ROOT / "Xauthority")
    PRIVATE["XDG_RUNTIME_DIR"] = str(RUNTIME / "r")
    Path(PRIVATE["XDG_RUNTIME_DIR"]).mkdir(mode=0o700, exist_ok=True)
    (RUNTIME / "x").mkdir(mode=0o700, exist_ok=True)

def restore_display(wait=3):
    configure_private()
    if not S.get("display"):
        until = time.monotonic() + wait
        while True:
            try: number = (ROOT / "display-number").read_text().strip()
            except OSError: number = ""
            if number.isdecimal() and 0 <= int(number) <= 65535:
                with LOCK: S["display"] = ":" + number; save()
                break
            if not matches(S["resources"].get("xvfb")) or time.monotonic() >= until: return False
            time.sleep(.03)
    PRIVATE["DISPLAY"] = S["display"]
    cookie = S.get("cookie")
    if not isinstance(cookie, str) or len(cookie) != 32 or any(c not in "0123456789abcdef" for c in cookie):
        # Old receipts already have a working display-specific client entry.
        return True
    r = quick([C["tools"]["xauth"], "-f", PRIVATE["XAUTHORITY"], "add", S["display"], ".", cookie])
    if r.returncode: raise RuntimeError("xauth_client_failed")
    return True

def quick(argv, env=None, timeout=4):
    return subprocess.run(argv, env=env or PRIVATE, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)

X_AUTH_LOCK = threading.RLock()
def open_display(env):
    from Xlib import display
    with X_AUTH_LOCK:
        old = os.environ.get("XAUTHORITY")
        try:
            if env.get("XAUTHORITY"): os.environ["XAUTHORITY"] = env["XAUTHORITY"]
            else: os.environ.pop("XAUTHORITY", None)
            return display.Display(env["DISPLAY"])
        finally:
            if old is None: os.environ.pop("XAUTHORITY", None)
            else: os.environ["XAUTHORITY"] = old

def window_ids(env):
    from Xlib import X, display
    d = open_display(env)
    try:
        prop = d.screen().root.get_full_property(d.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)
        return list(prop.value) if prop else []
    finally: d.close()

def release_input():
    if not S.get("display") or not matches(S["resources"].get("xvfb")): return
    try:
        from Xlib import X, display
        from Xlib.ext import xtest
        d = open_display(PRIVATE)
        try:
            keys = d.query_keymap()
            for code in range(8, 256):
                if keys[code >> 3] & (1 << (code & 7)):
                    xtest.fake_input(d, X.KeyRelease, code)
            for button in range(1, 6): xtest.fake_input(d, X.ButtonRelease, button)
            d.sync()
        finally: d.close()
    except Exception: pass

def physical_viewer_visible(record):
    if not matches(record): return False
    from Xlib import X, display
    d = open_display(PHYSICAL)
    try:
        root = d.screen().root
        prop = root.get_full_property(d.intern_atom("_NET_CLIENT_LIST"), X.AnyPropertyType)
        for wid in (list(prop.value) if prop else []):
            try:
                w = d.create_resource_object("window", wid)
                pid = w.get_full_property(d.intern_atom("_NET_WM_PID"), X.AnyPropertyType)
                if not pid or int(pid.value[0]) != record["pid"]: continue
                if w.get_attributes().map_state != X.IsViewable: continue
                # Xroot may contain gaps in an L-shaped physical monitor layout.
                # Place the retained viewer inside a real active RandR monitor.
                monitors = root.xrandr_get_monitors(True).monitors
                valid = [m for m in monitors if int(m.width_in_pixels) > 100 and int(m.height_in_pixels) > 100]
                if not valid: return False
                monitor = next((m for m in valid if bool(m.primary)), valid[0])
                mx, my = int(monitor.x), int(monitor.y)
                mw, mh = int(monitor.width_in_pixels), int(monitor.height_in_pixels)
                x, y = mx + 20, my + 20
                width = max(80, min(C["width"], mw - 40))
                height = max(80, min(C["height"], mh - 80))
                quick([C["tools"]["xdotool"], "windowmove", str(wid), str(x), str(y),
                       "windowsize", str(wid), str(width), str(height)], PHYSICAL)
                d.sync()
                raw = quick([C["tools"]["xdotool"], "getwindowgeometry", "--shell", str(wid)], PHYSICAL)
                geometry = {}
                for line in raw.stdout.decode().splitlines():
                    key, sep, value = line.partition("=")
                    if sep and value.lstrip("-").isdecimal(): geometry[key] = int(value)
                gx, gy = geometry.get("X", -999999), geometry.get("Y", -999999)
                gw, gh = geometry.get("WIDTH", 0), geometry.get("HEIGHT", 0)
                return gw > 0 and gh > 0 and mx <= gx < mx + mw and my <= gy < my + mh and gx + gw <= mx + mw and gy + gh <= my + mh
            except Exception: continue
        return False
    finally: d.close()

def recovery_empty_result(reason):
    result = {"complete": True, "outcome": "no-resources", "inputRevoked": True,
              "ownedDisplayRemoved": True, "details": {"reason": reason}}
    with LOCK:
        S["recovery"] = result; S["phase"] = "empty"; save()
    return result

def recovery(reason):
    global RETURNING, ACTIVE, CREATION_REVOKED
    with LOCK:
        CREATION_REVOKED = True
        revoke(reason)
        if S["phase"] in ("returned", "empty"): return S["recovery"]
        if RETURNING: return None
        RETURNING = True
        S["phase"] = "returning"; S["inputRevoked"] = True
        current_record = S.get("activeCommand")
        save()
    try:
        if not stop_record(current_record, immediate=True):
            raise RuntimeError("active_input_still_running")
        with EXEC_LOCK:
            with LOCK:
                S.pop("activeCommand", None)
                save()
            if matches(S["resources"].get("xvfb")): restore_display()
            release_input()
        owned = matches(S["resources"].get("xvfb"))
        if not owned:
            # The exact original X server is gone, including after host reboot.
            # Never attach to a reused display/PID, or signal applications.
            intent = S.get("creationIntents", {}).get("xvfb")
            if intent and not S["resources"].get("xvfb") and (
                    intent.get("protocol") != "pipe-go-v1" or intent.get("stage") != "prepared"):
                # Unknown/partial older records cannot prove an X server never
                # started. A pipe-go-v1 prepared intent is safe: no committed
                # identity means GO was never sent, even if fork already ran.
                raise RuntimeError("unresolved_xvfb_creation")
            stop_owned("xpra"); stop_owned("wm")
            result = {"complete": True, "outcome": "no-resources",
                      "inputRevoked": True, "ownedDisplayRemoved": True,
                      "details": {"reason": reason, "originalServerGone": True, "applicationsSignalled": False}}
        else:
            if not S.get("display"):
                if S.get("appLaunchIntent") or S["resources"].get("app") or S.get("interactionStarted"):
                    raise RuntimeError("owned_display_number_unavailable")
                stop_owned("xvfb")
                if matches(S["resources"].get("xvfb")): raise RuntimeError("owned_xvfb_still_running")
                return recovery_empty_result(reason)
            apps = window_ids(PRIVATE)
            # A first window may not yet be mapped, or the WM may be restarting.
            # Never destroy a desktop that launched an app or accepted input.
            if not apps and not S.get("appLaunchIntent") and not S["resources"].get("app") and not S.get("interactionStarted"):
                stop_owned("xpra"); stop_owned("wm"); stop_owned("xvfb")
                removed = not matches(S["resources"].get("xvfb"))
                result = {"complete": removed, "outcome": "no-resources" if removed else "cleanup-pending",
                          "inputRevoked": True, "ownedDisplayRemoved": removed, "details": {"reason": reason}}
            else:
                viewer = S["resources"].get("viewer")
                if not matches(viewer):
                    env = dict(PHYSICAL); env["GDK_BACKEND"] = "x11"
                    argv = [C["tools"]["xpra"], "attach", S["display"],
                            "--socket-dir=" + str(RUNTIME / "x"), "--socket-dirs=" + str(RUNTIME / "x"),
                            "--clipboard=no", "--speaker=off", "--microphone=off", "--webcam=no",
                            "--notifications=no", "--system-tray=no", "--opengl=no", "--mmap=no",
                            "--title=Relay recovered workspace"]
                    launch("viewer", argv, env)
                    viewer = S["resources"].get("viewer")
                until = time.monotonic() + 8
                visible = False
                while time.monotonic() < until:
                    if physical_viewer_visible(viewer): visible = True; break
                    if not matches(viewer): break
                    time.sleep(.15)
                result = {"complete": visible, "outcome": "handoff-viewer" if visible else "cleanup-pending",
                          "inputRevoked": True, "ownedDisplayRemoved": False,
                          "details": {"reason": reason, "appsPreserved": True, "physicalViewerVisible": visible,
                                      "physicalMonitorTopologyChanged": False,
                                      "returnDisplay": PHYSICAL["DISPLAY"], "viewerPid": viewer["pid"] if viewer else None}}
        with LOCK:
            S["recovery"] = result
            S["phase"] = ("empty" if result["ownedDisplayRemoved"] else "returned") if result["complete"] else "cleanup_pending"
            save()
        return result
    except Exception as e:
        with LOCK:
            S["phase"] = "cleanup_pending"
            S["recovery"] = {"complete": False, "outcome": "cleanup-pending", "inputRevoked": True,
                            "ownedDisplayRemoved": False, "details": {"reason": reason, "error": type(e).__name__}}
            save()
        return S["recovery"]
    finally:
        with LOCK: RETURNING = False

def create():
    global LAST_HEARTBEAT
    try:
        configure_private()
        cookie = os.urandom(16).hex()
        with LOCK: S["cookie"] = cookie; save()
        # Server authentication and the display number survive guardian loss.
        # A pipe would lose Xvfb's allocated number if the only reader died.
        r = quick([C["tools"]["xauth"], "-f", PRIVATE["XAUTHORITY"], "add", ":0", ".", cookie])
        if r.returncode: raise RuntimeError("xauth_failed")
        display_fd = os.open(str(ROOT / "display-number"), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            argv = [C["tools"]["Xvfb"], "-displayfd", str(display_fd), "-screen", "0",
                    "%dx%dx24" % (C["width"], C["height"]), "-nolisten", "tcp", "-noreset",
                    "-auth", PRIVATE["XAUTHORITY"]]
            launch("xvfb", argv, PRIVATE, pass_fds=(display_fd,))
        finally: os.close(display_fd)
        until = time.monotonic() + 12
        while time.monotonic() < until:
            number = (ROOT / "display-number").read_text().strip()
            if number.isdecimal():
                # relay-test-boundary: after-xvfb-display-allocation
                with LOCK: S["display"] = ":" + number; save()
                break
            if revoked(): raise RuntimeError("creation_cancelled")
            if not matches(S["resources"].get("xvfb")): raise RuntimeError("xvfb_exited")
            time.sleep(.03)
        else: raise RuntimeError("xvfb_start_timeout")
        if not restore_display(): raise RuntimeError("xvfb_display_invalid")
        launch("wm", [C["tools"]["openbox"], "--sm-disable"], PRIVATE)
        argv = [C["tools"]["xpra"], "start-desktop", S["display"], "--use-display=yes", "--daemon=no",
                "--socket-dir=" + str(RUNTIME / "x"), "--socket-dirs=" + str(RUNTIME / "x"),
                "--socket-permissions=600", "--mdns=no", "--clipboard=no", "--speaker=off", "--microphone=off",
                "--webcam=no", "--notifications=no", "--system-tray=no", "--pulseaudio=no",
                "--printing=no", "--file-transfer=no", "--open-files=no", "--start-new-commands=no",
                "--exit-with-client=no", "--exit-with-children=no", "--start-via-proxy=no",
                "--systemd-run=no", "--resize-display=no", "--dbus-launch=no", "--html=off", "--mmap=no"]
        launch("xpra", argv, PRIVATE)
        until = time.monotonic() + 20
        while time.monotonic() < until:
            if not matches(S["resources"]["xpra"]): raise RuntimeError("xpra_exited")
            try:
                r = quick([C["tools"]["xpra"], "info", S["display"],
                           "--socket-dir=" + str(RUNTIME / "x"), "--socket-dirs=" + str(RUNTIME / "x")], timeout=3)
                if r.returncode == 0: break
            except subprocess.TimeoutExpired:
                if revoked(): raise RuntimeError("creation_cancelled")
            time.sleep(.15)
        else: raise RuntimeError("xpra_start_timeout")
        if C.get("launch"):
            launch("app", [C["launch"]["executable"]] + C["launch"]["args"], PRIVATE)
        with LOCK:
            if S["phase"] == "starting":
                S["phase"] = "active"; LAST_HEARTBEAT = time.monotonic(); save()
    except Exception as e:
        with LOCK: S["error"] = str(e)[:160]; save()
        recovery("open_failed")

def still_connected(conn):
    try:
        ready, _, _ = select.select([conn], [], [], 0)
        return not ready or conn.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) != b""
    except OSError: return False

def execute(req, conn):
    global ACTIVE
    command = req["command"]
    if command not in (C["tools"]["xdotool"], C["tools"]["capture"]):
        raise RuntimeError("command_not_allowed")
    argv = req.get("args")
    if not isinstance(argv, list) or len(argv) > 256 or any(not isinstance(x, str) for x in argv):
        raise RuntimeError("invalid_arguments")
    with EXEC_LOCK:
        with LOCK:
            if revoked() or S["phase"] != "active" or time.monotonic() >= EXPIRY_MONO:
                raise RuntimeError("workspace_input_revoked")
            if command == C["tools"]["xdotool"] and argv and not argv[0].startswith("get"):
                S["interactionStarted"] = True; save()
            data = base64.b64decode(req.get("input", ""), validate=True)
            if len(data) > 1048576: raise RuntimeError("input_too_large")
            p = spawn_owned("command", [command] + argv, PRIVATE, ephemeral=True,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            ACTIVE = p
            record = S["activeCommand"]
        timeout = min(120, max(.001, req.get("timeoutMs", 30000)/1000))
        end = time.monotonic() + timeout
        output = [None]
        def collect():
            try: output[0] = p.communicate(data)
            except Exception: output[0] = (b"", b"native_io_failed")
        thread = threading.Thread(target=collect, daemon=True); thread.start()
        failure = None
        while p.poll() is None:
            if revoked() or S["inputRevoked"] or time.monotonic() >= EXPIRY_MONO: failure = "workspace_input_revoked"
            elif time.monotonic() >= end: failure = "native_timeout"
            elif not still_connected(conn): failure = "caller_disconnected"
            if failure:
                try: os.killpg(p.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                break
            time.sleep(.02)
        thread.join(2)
        with LOCK:
            ACTIVE = None
            if S.get("activeCommand") == record and not matches(record):
                S.pop("activeCommand", None); save()
        if failure: release_input(); raise RuntimeError(failure)
        stdout, stderr = output[0] or (b"", b"")
        if len(stdout) > 12582912: raise RuntimeError("output_too_large")
        return {"stdout": base64.b64encode(stdout).decode(), "stderr": base64.b64encode(stderr[:262144]).decode(),
                "exitCode": p.returncode}

class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        global LAST_HEARTBEAT, EXPIRY_MONO
        try:
            self.connection.settimeout(5)
            line = self.rfile.readline(2097153)
            if not line or len(line) > 2097152: return
            req = json.loads(line)
            if not hmac.compare_digest(str(req.get("secret", "")), C["secret"]): return
            self.connection.settimeout(None)
            operation = req.get("operation")
            if operation == "status":
                with LOCK: result = dict(S)
            elif operation == "renew":
                with LOCK:
                    if revoked() or S["phase"] != "active": raise RuntimeError("workspace_input_revoked")
                    expiry = int(req["expiresAt"])
                    if expiry > C["hardExpiresAt"] or expiry <= time.time()*1000:
                        raise RuntimeError("invalid_expiry")
                    if expiry != S["expiresAt"]:
                        EXPIRY_MONO = min(HARD_MONO, time.monotonic() + (expiry - time.time()*1000)/1000)
                        S["expiresAt"] = expiry
                    LAST_HEARTBEAT = time.monotonic()
                    result = {"renewed": True}
            elif operation == "execute": result = execute(req, self.connection)
            elif operation == "recover": result = recovery(str(req.get("reason", "recovery")))
            else: raise RuntimeError("unknown_operation")
            response = {"ok": True, "result": result}
        except Exception as e:
            response = {"ok": False, "error": str(e)[:200]}
        try: self.wfile.write((json.dumps(response)+"\n").encode()); self.wfile.flush()
        except OSError: pass

class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

def watchdog():
    terminal_at = None
    while not STOP.wait(.25):
        with LOCK:
            phase = S["phase"]; elapsed = time.monotonic() - LAST_HEARTBEAT
            expired = time.monotonic() >= EXPIRY_MONO or time.time()*1000 >= S["expiresAt"]
            hard_expired = time.monotonic() >= HARD_MONO or time.time()*1000 >= C["hardExpiresAt"]
        if phase in ("empty", "returned"):
            if terminal_at is None: terminal_at = time.monotonic()
            elif time.monotonic() - terminal_at > 8: os._exit(0)
            continue
        if revoked():
            recovery("revoked")
        elif phase == "starting":
            if elapsed > 45 or hard_expired: recovery("open_timeout")
        elif phase == "active" and (expired or hard_expired or elapsed > 15):
            recovery("expired" if expired or hard_expired else "broker_lost")
        elif phase == "cleanup_pending":
            recovery("recovery_retry"); STOP.wait(3)

if len(sys.argv) > 2 and sys.argv[2] == "--recover":
    if STATE.exists():
        prior = json.loads(STATE.read_text())
        if prior.get("instanceId") != C["instanceId"]: raise RuntimeError("resource_identity_mismatch")
        S = prior
        configure_private()
    recovery("recovery")
    sys.exit(0 if S["recovery"] and S["recovery"]["complete"] else 1)

runtime_stat = RUNTIME.lstat()
if not stat.S_ISDIR(runtime_stat.st_mode) or runtime_stat.st_uid != os.getuid() or runtime_stat.st_mode & 0o077:
    raise RuntimeError("runtime_directory_not_private")
SOCKET = RUNTIME / "g.sock"
if SOCKET.exists(): raise RuntimeError("guardian_already_exists")
server = Server(str(SOCKET), Handler)
os.chmod(SOCKET, 0o600)
S["guardian"] = identity(os.getpid())
save()
threading.Thread(target=(lambda: recovery("revoked_before_start")) if revoked() else create, daemon=True).start()
threading.Thread(target=watchdog, daemon=True).start()
for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(sig, lambda *_: threading.Thread(target=recovery, args=("guardian_signal",), daemon=True).start())
server.serve_forever(poll_interval=.2)
`;