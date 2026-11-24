import { waylandEisHelper } from "./wayland-eis-helper.js";
import { waylandLayoutHelper } from "./wayland-layout-helper.js";

/** Desktop-approved Wayland capture/input. The portal grant lives only in this child. */
export const waylandHelper = waylandEisHelper + waylandLayoutHelper + String.raw`#!/usr/bin/env python3
import base64
import json
import math
import os
import queue
import re
import signal
import struct
import sys
import threading
import time
import uuid

PORTAL = "org.freedesktop.portal.Desktop"
DESKTOP = "/org/freedesktop/portal/desktop"
REMOTE = "org.freedesktop.portal.RemoteDesktop"
SCREEN = "org.freedesktop.portal.ScreenCast"
REQUEST = "org.freedesktop.portal.Request"
SESSION = "org.freedesktop.portal.Session"
MAX_REQUEST = 256 * 1024
MAX_PNG = 12 * 1024 * 1024
MAX_PIXELS = 120000000
IDLE_SECONDS = 300
STOP = threading.Event()
OUTPUT_LOCK = threading.Lock()
Gio = GLib = Gst = None
MISSING = []
try:
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except (ImportError, ValueError):
    MISSING.append("python3-gi / Gio")
try:
    if Gio is not None:
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
        Gst.init(None)
        for plugin in ("pipewiresrc", "videoconvert", "capsfilter", "pngenc", "appsink"):
            if Gst.ElementFactory.find(plugin) is None:
                MISSING.append("GStreamer " + plugin)
except (ImportError, ValueError):
    MISSING.append("GStreamer introspection")


class Failure(Exception):
    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


class Context:
    def __init__(self, timeout_ms):
        if type(timeout_ms) is not int or not 1 <= timeout_ms <= 120000:
            raise Failure("invalid_timeout", "Wayland timeout must be 1-120000 ms.")
        self.deadline = time.monotonic() + timeout_ms / 1000

    def check(self):
        if STOP.is_set():
            raise Failure("cancelled", "Wayland operation was cancelled.", {"mayHaveApplied": True})
        if time.monotonic() >= self.deadline:
            raise Failure("timeout", "Wayland operation exceeded its deadline.", {"mayHaveApplied": True})

    def remaining(self, maximum=1000):
        self.check()
        return max(1, min(maximum, math.ceil((self.deadline - time.monotonic()) * 1000)))

    def sleep(self, seconds):
        self.check()
        STOP.wait(min(seconds, max(0, self.deadline - time.monotonic())))
        self.check()


def integer(value, minimum, maximum):
    return type(value) is int and minimum <= value <= maximum


def png_geometry(data):
    if (len(data) < 33 or len(data) > MAX_PNG or data[:8] != b"\x89PNG\r\n\x1a\n"
            or data[8:16] != b"\x00\x00\x00\rIHDR"):
        raise Failure("invalid_screenshot", "Wayland capture did not produce a bounded PNG.")
    width, height = struct.unpack(">II", data[16:24])
    if not 1 <= width <= 32768 or not 1 <= height <= 32768 or width * height > MAX_PIXELS:
        raise Failure("invalid_screenshot", "Wayland screenshot dimensions exceed supported limits.")
    return width, height


KEYS = {
    "ctrl": 0xffe3, "control": 0xffe3, "control_l": 0xffe3, "control_r": 0xffe4,
    "shift": 0xffe1, "shift_l": 0xffe1, "shift_r": 0xffe2,
    "alt": 0xffe9, "option": 0xffe9, "alt_l": 0xffe9, "alt_r": 0xffea,
    "meta": 0xffeb, "super": 0xffeb, "win": 0xffeb, "command": 0xffeb,
    "super_l": 0xffeb, "super_r": 0xffec,
    "enter": 0xff0d, "return": 0xff0d, "tab": 0xff09, "escape": 0xff1b, "esc": 0xff1b,
    "backspace": 0xff08, "delete": 0xffff, "insert": 0xff63, "space": 0x20,
    "home": 0xff50, "end": 0xff57, "pageup": 0xff55, "pagedown": 0xff56,
    "up": 0xff52, "down": 0xff54, "left": 0xff51, "right": 0xff53,
    "capslock": 0xffe5, "printscreen": 0xff61,
}


def keysym(name):
    if not isinstance(name, str) or not 1 <= len(name) <= 48:
        raise Failure("unsupported_key", "Unsupported Wayland key name.")
    if name.lower() in KEYS:
        return KEYS[name.lower()]
    if len(name) == 1 and 32 <= ord(name) <= 126:
        return ord(name)
    if re.fullmatch(r"F(?:[1-9]|1[0-9]|2[0-4])", name):
        return 0xffbe + int(name[1:]) - 1
    raise Failure("unsupported_key", "Unsupported Wayland key name.")


def text_keysyms(text):
    if not isinstance(text, str) or len(text) > 16384:
        raise Failure("invalid_action", "Wayland text must contain at most 16384 characters.")
    # Preflight the whole string before the EIS keyboard map is consulted.
    # Never send part of a string and then discover a control or Unicode key.
    if any(not 32 <= ord(c) <= 126 for c in text):
        raise Failure("text_unsupported", "This Wayland backend supports printable ASCII text only. Use an explicit key action for Enter or Tab; arbitrary Unicode requires compositor-specific support.")
    return [ord(c) for c in text]


def validate_action(action, display):
    if not isinstance(action, dict):
        raise Failure("invalid_action", "Wayland action must be an object.")
    kind = action.get("type")
    fields = {
        "move": {"type", "x", "y"}, "click": {"type", "x", "y", "button", "clicks"},
        "drag": {"type", "fromX", "fromY", "toX", "toY", "durationMs"},
        "scroll": {"type", "direction", "amount", "x", "y"},
        "key": {"type", "keys"}, "text": {"type", "text"},
    }
    if kind not in fields or set(action) - fields[kind]:
        raise Failure("invalid_action", "Unsupported Wayland action fields.")
    pairs = [("x", "y")] if kind in ("move", "click") else []
    if kind == "drag":
        pairs = [("fromX", "fromY"), ("toX", "toY")]
        if not integer(action.get("durationMs", 400), 100, 5000):
            raise Failure("invalid_action", "Drag duration must be 100-5000 ms.")
    if kind == "scroll":
        if action.get("direction") not in ("up", "down", "left", "right") or not integer(action.get("amount", 3), 1, 40):
            raise Failure("invalid_action", "Invalid Wayland scroll direction or amount.")
        if "x" in action or "y" in action:
            pairs = [("x", "y")]
    for x, y in pairs:
        if not integer(action.get(x), 0, display["width"] - 1) or not integer(action.get(y), 0, display["height"] - 1):
            raise Failure("out_of_bounds", "Wayland coordinates must be within the captured display.")
    if kind == "click" and (action.get("button", "left") not in ("left", "right", "middle")
                            or not integer(action.get("clicks", 1), 1, 3)):
        raise Failure("invalid_action", "Invalid Wayland pointer button or click count.")
    if kind == "key":
        names = action.get("keys")
        if not isinstance(names, list) or not 1 <= len(names) <= 8:
            raise Failure("invalid_action", "Wayland key chords require 1-8 keys.")
        return [keysym(name) for name in names]
    if kind == "text":
        return text_keysyms(action.get("text"))
    return None


class Portal:
    def __init__(self):
        self.bus = None
        self.owner = None
        self.owner_subscription = None
        self.session_subscription = None
        self.session = None
        self.epoch = None
        self.active = False
        self.revoked = threading.Event()
        self.requests = set()
        self.streams = []
        self.held_keys = []
        self.held_buttons = []
        self.eis = None
        self.layout = None
        self.eis_generation = None
        self.needs_setup = False
        self.granted_devices = 0
        self.input_reason = "Authorize a desktop session before sending input."
        self.remote_properties = {}
        self.screen_properties = {}
        self.permission = "unknown"
        self.last_reason = "Use computer_setup to choose monitors and approve remote input in the local desktop dialog."

    def call(self, interface, method, parameters, ctx, reply=None, path=DESKTOP, maximum=1000):
        try:
            return self.bus.call_sync(PORTAL, path, interface, method, parameters,
                GLib.VariantType.new(reply) if reply else None, Gio.DBusCallFlags.NONE, ctx.remaining(maximum), None)
        except Exception:
            ctx.check()
            raise Failure("portal_unavailable", "The desktop portal rejected the operation or became unavailable.")

    def notify(self, method, signature, arguments, ctx):
        self.require_session(ctx)
        if self.eis is not None:
            raise Failure("input_transport_changed", "Notify input is forbidden after connecting EIS.")
        if self.layout is None:
            raise Failure("input_unavailable", self.input_reason)
        self.layout.check(ctx)
        self.call(REMOTE, method, GLib.Variant(signature, (self.session, {}, *arguments)), ctx, maximum=250)
        self.require_session(ctx)

    def closed(self, *_args):
        self.revoked.set()
        self.active = False
        self.permission = "unknown"
        self.last_reason = "The desktop portal session was closed. Run computer_setup to authorize a new session."

    def connect(self, ctx):
        if self.bus is not None and not self.bus.is_closed():
            return
        try:
            self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            self.bus.set_exit_on_close(False)
            self.bus.connect("closed", self.closed)
            def owner_changed(_connection, _sender, _path, _interface, _signal, parameters, *_):
                _name, old, new = parameters.unpack()
                if self.owner and old == self.owner and new != self.owner:
                    self.closed()
                self.owner = new or None
            self.owner_subscription = self.bus.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus",
                "NameOwnerChanged", "/org/freedesktop/DBus", PORTAL, Gio.DBusSignalFlags.NONE, owner_changed)
        except Exception:
            ctx.check()
            raise Failure("portal_unavailable", "No desktop session bus is available. Start relay in the Wayland desktop user session.")

    def probe(self, ctx):
        if MISSING:
            raise Failure("dependency_missing", "Install system Python GObject introspection, GStreamer introspection, PipeWire and the GStreamer PipeWire/good/base plugins.", {"missing": list(MISSING)})
        if not os.environ.get("WAYLAND_DISPLAY") or not os.environ.get("XDG_RUNTIME_DIR"):
            raise Failure("desktop_unavailable", "No Wayland desktop is attached. Start relay in the desktop user session with WAYLAND_DISPLAY and XDG_RUNTIME_DIR.")
        self.connect(ctx)
        self.remote_properties = self.call("org.freedesktop.DBus.Properties", "GetAll",
            GLib.Variant("(s)", (REMOTE,)), ctx, "(a{sv})").unpack()[0]
        self.screen_properties = self.call("org.freedesktop.DBus.Properties", "GetAll",
            GLib.Variant("(s)", (SCREEN,)), ctx, "(a{sv})").unpack()[0]
        try:
            owner = self.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                "GetNameOwner", GLib.Variant("(s)", (PORTAL,)), GLib.VariantType.new("(s)"),
                Gio.DBusCallFlags.NONE, ctx.remaining(1000), None).unpack()[0]
            if self.owner and owner != self.owner:
                self.closed()
            self.owner = owner
        except Exception:
            ctx.check()
            raise Failure("portal_unavailable", "The desktop portal service disappeared while checking capabilities.")
        if not integer(self.remote_properties.get("version"), 1, 100) or not integer(self.screen_properties.get("version"), 1, 100):
            raise Failure("portal_unsupported", "The desktop must provide both RemoteDesktop and ScreenCast portals; an XWayland display alone is insufficient.")
        if int(self.remote_properties.get("AvailableDeviceTypes", 0)) & 3 != 3:
            raise Failure("portal_unsupported", "The desktop RemoteDesktop portal does not provide both keyboard and pointer input.")
        if not int(self.screen_properties.get("AvailableSourceTypes", 0)) & 1:
            raise Failure("portal_unsupported", "The desktop ScreenCast portal does not provide monitor capture.")

    def request(self, interface, method, signature, prefix, options, ctx):
        token = "relay_" + uuid.uuid4().hex
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        request_prefix = DESKTOP + "/request/" + sender + "/"
        path = request_prefix + token
        paths = {"actual": path}
        responses = {}
        event = threading.Event()
        def response(_connection, _sender, response_path, _interface, _signal, parameters, *_):
            # Subscribe before sending the method: fast responses can arrive
            # before its method reply. This connection belongs only to us.
            if response_path.startswith(request_prefix) and len(responses) < 8:
                responses[response_path] = parameters.unpack()
                if response_path == paths["actual"]:
                    event.set()
        subscription = self.bus.signal_subscribe(PORTAL, REQUEST, "Response", None, None,
            Gio.DBusSignalFlags.NONE, response)
        self.requests.add(path)
        completed = False
        try:
            options = dict(options, handle_token=GLib.Variant("s", token))
            result = self.call(interface, method, GLib.Variant(signature, (*prefix, options)), ctx, "(o)")
            actual = result.unpack()[0]
            if not isinstance(actual, str) or not actual.startswith(request_prefix):
                raise Failure("portal_protocol", "The desktop returned an invalid request handle.")
            paths["actual"] = actual
            self.requests.add(actual)
            while actual not in responses:
                ctx.check()
                event.wait(min(0.025, ctx.remaining() / 1000))
                event.clear()
            code, values = responses[actual]
            ctx.check()
            completed = True
            if code == 1:
                self.permission = "denied"
                raise Failure("permission_denied", "Desktop sharing was cancelled or denied in the local portal dialog.")
            if code != 0:
                raise Failure("portal_request_failed", "The desktop portal could not complete the sharing request.")
            if not isinstance(values, dict):
                raise Failure("portal_protocol", "The desktop returned an invalid request response.")
            return values
        finally:
            if not completed:
                self.close_object(paths["actual"], REQUEST)
                if paths["actual"] != path:
                    self.close_object(path, REQUEST)
            self.requests.discard(path)
            self.requests.discard(paths["actual"])
            self.bus.signal_unsubscribe(subscription)

    def close_object(self, path, interface):
        if self.bus is None or self.bus.is_closed():
            return
        try:
            self.bus.call_sync(PORTAL, path, interface, "Close", None, None,
                Gio.DBusCallFlags.NONE, 100, None)
        except Exception:
            pass

    def release_inputs(self):
        if self.eis is not None:
            return self.eis.release()
        clean = True
        buttons, keys = list(reversed(self.held_buttons)), list(reversed(self.held_keys))
        self.held_buttons.clear()
        self.held_keys.clear()
        for method, values in (("NotifyPointerButton", buttons), ("NotifyKeyboardKeysym", keys)):
            for value in values:
                try:
                    self.bus.call_sync(PORTAL, DESKTOP, REMOTE, method,
                        GLib.Variant("(oa{sv}iu)", (self.session, {}, value, 0)), None,
                        Gio.DBusCallFlags.NONE, 75, None)
                except Exception:
                    clean = False
        return clean

    def close(self, release=True):
        if release:
            self.release_inputs()
        if self.eis is not None:
            self.eis.close()
            self.eis = None
        if self.layout is not None:
            self.layout.close()
            self.layout = None
        self.eis_generation = None
        self.needs_setup = False
        self.granted_devices = 0
        self.active = False
        if self.permission == "granted":
            self.permission = "unknown"
        self.revoked.set()
        for path in list(self.requests):
            self.close_object(path, REQUEST)
        self.requests.clear()
        if self.session:
            self.close_object(self.session, SESSION)
        if self.session_subscription is not None and self.bus is not None:
            self.bus.signal_unsubscribe(self.session_subscription)
        self.session_subscription = None
        self.session = self.epoch = None
        self.streams = []

    def require_session(self, ctx):
        ctx.check()
        if not self.active or self.revoked.is_set() or not self.session:
            raise Failure("portal_session_required", "Run computer_setup and approve sharing in the local desktop before capturing or sending input.")

    def invalidate_unstable_streams(self):
        # Portal versions predating pipewire-serial cannot distinguish a new
        # PipeWire object that reuses an old node id after topology changes.
        if any(stream.get("serial") is None for stream in self.streams):
            self.close()
            self.last_reason = "The display changed and this portal does not provide stable PipeWire stream serials. Run computer_setup to authorize the current monitors again."
            raise Failure("display_changed", self.last_reason, {"setupRequired": True})

    def refresh_eis(self):
        self.eis.pump()
        if self.eis_generation is not None and self.eis_generation != self.eis.generation:
            self.needs_setup = True
            self.invalidate_unstable_streams()
        self.eis_generation = self.eis.generation

    def check_capture_identity(self):
        if self.eis is not None:
            self.refresh_eis()
        elif self.layout is not None:
            fenced = getattr(self.layout, "fenced", None)
            if fenced is not None and fenced.is_set():
                self.invalidate_unstable_streams()

    def input_available(self, ctx):
        if not self.active or self.revoked.is_set():
            return False
        if not self.granted_devices & 2:
            self.input_reason = "Pointer input was not granted for this session. Capture remains available; run computer_setup to approve input."
            return False
        if self.eis is not None:
            try:
                self.refresh_eis()
                if not self.eis.ready(self.streams):
                    self.input_reason = "EIS devices or monitor regions are not ready. Capture again after the desktop settles, or reauthorize with computer_setup."
                    return False
                for stream in self.streams:
                    self.eis.display(stream)
                return True
            except Exception:
                self.close()
                raise
        if self.layout is not None:
            try:
                self.layout.check(ctx)
                return True
            except Failure as error:
                if error.code in ("cancelled", "timeout"):
                    raise
                self.needs_setup = True
                self.input_reason = error.message
                if error.code == "display_changed":
                    self.invalidate_unstable_streams()
        return False

    def require_input(self, ctx):
        self.require_session(ctx)
        if not self.input_available(ctx):
            raise Failure("input_unavailable", self.input_reason)

    def input_actions(self):
        actions = self.eis.actions(self.streams) if self.eis is not None else ["move", "click", "drag", "scroll"]
        if not self.granted_devices & 1:
            actions = [action for action in actions if action not in ("key", "text")]
        return actions

    def poll(self):
        if self.revoked.is_set() and (self.session is not None or self.eis is not None):
            self.close()
            return
        if self.eis is not None:
            try:
                self.refresh_eis()
            except Exception as error:
                self.last_reason = error.message if isinstance(error, Failure) else "The compositor input connection closed. Run computer_setup to authorize a new session."
                self.close()
        elif self.layout is not None:
            try:
                self.check_capture_identity()
            except Failure:
                pass

    def state(self, ctx, probe=True):
        failure = None
        if probe:
            try:
                self.probe(ctx)
            except Failure as error:
                if error.code in ("cancelled", "timeout"):
                    raise
                failure = error
                if self.active:
                    self.close()
        input_available = False
        if failure is None and self.active and not self.revoked.is_set():
            try:
                input_available = self.input_available(ctx)
            except Failure as error:
                if error.code in ("cancelled", "timeout"):
                    raise
                failure = error
        available = failure is None and self.active and not self.revoked.is_set() and bool(self.streams)
        actions = self.input_actions() if input_available else []
        details = {
            "setupRequired": not available or not input_available,
            "setup": "Use computer_setup to approve monitor sharing and remote input in the local desktop dialog.",
            "coordinateSpace": "Captured monitor pixels mapped to a live EIS region; legacy Notify is restricted to guarded GNOME scale-1 monitors",
            "capture": "Fresh authorized PipeWire connection for each screenshot; no cached pre-action frames",
            "sessionPersistence": "None; permission is released on helper exit, disconnect, handoff or five idle minutes",
            "inputTransport": "eis" if self.eis is not None else "gnome-legacy" if input_available else "none",
            "inputMethod": "EIS/libei with compositor XKB map" if self.eis is not None else "RemoteDesktop Notify with live GNOME layout guard" if input_available else "capture-only",
            "textSupport": "Printable ASCII representable by the active keyboard map with unmodified or Shift keys; Enter and Tab require explicit key actions. Application keyboard handling and concurrent local input may vary." if "key" in actions else "Keyboard requires a usable compositor keymap and an authoritative initial EIS modifier/layout snapshot. This desktop has not supplied both; available pointer actions are listed in actions." if self.eis is not None else "Keyboard and text input require EIS with a compositor keyboard map. Legacy Notify input supports pointer actions only because it cannot resolve the active keyboard map and modifiers.",
            "clipboardAccess": False,
            "xwaylandIgnored": bool(os.environ.get("DISPLAY")),
            "remoteDesktopVersion": self.remote_properties.get("version"),
            "screenCastVersion": self.screen_properties.get("version"),
        }
        if available and not input_available:
            details["inputReason"] = self.input_reason
        if failure:
            details["errorCode"] = failure.code
            if failure.details:
                details.update(failure.details)
        state = {
            "platform": "linux", "backend": "linux-wayland-portal", "available": available,
            "displayKind": "physical" if available else "none",
            "inputKind": "mouse_keyboard" if input_available else "none",
            "displays": [dict(stream["display"]) for stream in self.streams] if available else [],
            "actions": actions,
            "unicodeText": False,
            "permissions": {"screenCapture": "granted" if available else self.permission,
                            "input": "granted" if input_available else "denied" if available else self.permission, "unlocked": "unknown"},
            "details": details,
        }
        if not available:
            state["reason"] = failure.message if failure else self.last_reason
        return state

    def setup(self, ctx):
        if self.active and not self.revoked.is_set():
            current = self.state(ctx)
            if current["inputKind"] != "none" and not self.needs_setup:
                return {"state": current, "automaticInstall": False}
        self.close()
        self.probe(ctx)
        # Freeze legacy display identity before any consent dialog can open.
        # EIS later replaces this guard with its own live region identities.
        self.layout = LegacyLayout(self, ctx)
        self.permission = "unknown"
        self.revoked.clear()
        self.epoch = uuid.uuid4().hex
        token = "relay_session_" + uuid.uuid4().hex
        sender = self.bus.get_unique_name()[1:].replace(".", "_")
        session_prefix = DESKTOP + "/session/" + sender + "/"
        # Retain the predicted object before CreateSession so cancellation even
        # between Response and assignment closes the newly created session.
        self.session = session_prefix + token
        try:
            created = self.request(REMOTE, "CreateSession", "(a{sv})", (),
                {"session_handle_token": GLib.Variant("s", token)}, ctx)
            session = created.get("session_handle")
            if not isinstance(session, str) or not session.startswith(session_prefix):
                raise Failure("portal_protocol", "The desktop returned an invalid session handle.")
            self.session = session
            def session_closed(_connection, _sender, path, *_args):
                if path == self.session:
                    self.closed()
            self.session_subscription = self.bus.signal_subscribe(PORTAL, SESSION, "Closed", session, None,
                Gio.DBusSignalFlags.NONE, session_closed)
            self.request(REMOTE, "SelectDevices", "(oa{sv})", (session,),
                {"types": GLib.Variant("u", 3)}, ctx)
            sources = {"types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", True)}
            cursor_modes = int(self.screen_properties.get("AvailableCursorModes", 0))
            if self.screen_properties.get("version", 1) >= 2 and cursor_modes & 2:
                sources["cursor_mode"] = GLib.Variant("u", 2)
            self.request(SCREEN, "SelectSources", "(oa{sv})", (session,), sources, ctx)
            started = self.request(REMOTE, "Start", "(osa{sv})", (session, ""), {}, ctx)
            if self.revoked.is_set():
                raise Failure("portal_session_closed", "The desktop closed the remote control session during setup.")
            if not integer(started.get("devices"), 0, 7):
                raise Failure("portal_protocol", "The portal returned invalid granted input devices.")
            self.granted_devices = started["devices"]
            streams = started.get("streams")
            if not isinstance(streams, (list, tuple)) or not 1 <= len(streams) <= 8:
                raise Failure("portal_protocol", "Select between one and eight monitors in the desktop sharing dialog.")
            seen = set()
            for item in streams:
                if not isinstance(item, (list, tuple)) or len(item) != 2:
                    raise Failure("portal_protocol", "The desktop returned an invalid monitor stream.")
                node, properties = item
                if not integer(node, 1, 0xffffffff) or node in seen or not isinstance(properties, dict):
                    raise Failure("portal_protocol", "The desktop returned an invalid monitor stream identity.")
                seen.add(node)
                if properties.get("source_type", 1) != 1:
                    raise Failure("portal_protocol", "Only existing monitor streams are supported by foreground Wayland control.")
                logical = properties.get("logical_size", properties.get("size"))
                if not isinstance(logical, (list, tuple)) or len(logical) != 2 or not all(integer(x, 1, 32768) for x in logical):
                    logical = None
                position = properties.get("position")
                if not isinstance(position, (list, tuple)) or len(position) != 2 or not all(integer(x, -0x80000000, 0x7fffffff) for x in position):
                    position = None
                mapping = properties.get("mapping_id")
                if not isinstance(mapping, str) or not 1 <= len(mapping) <= 512:
                    mapping = None
                serial = properties.get("pipewire-serial")
                if serial is not None and not integer(serial, 1, 0xffffffffffffffff):
                    raise Failure("portal_protocol", "The desktop returned an invalid PipeWire stream serial.")
                self.streams.append({"node": node, "serial": serial, "logical": logical, "position": position,
                    "mapping": mapping, "epoch": self.epoch,
                    "display": {"id": "wayland:" + str(node), "instanceId": self.epoch + ":" + str(serial or node),
                        "x": 0, "y": 0, "width": logical[0] if logical else 1, "height": logical[1] if logical else 1, "scaleX": 1, "scaleY": 1,
                        "rotation": 0, "primary": len(seen) == 1, "name": "Portal monitor " + str(len(seen))}})
            self.active = True
            for stream in self.streams:
                self.capture(stream, ctx)
            candidate = None
            mappings = [stream["mapping"] for stream in self.streams]
            if self.remote_properties.get("version", 0) >= 2 and all(mappings) and len(set(mappings)) == len(mappings):
                try:
                    candidate = EisInput()
                except (OSError, AttributeError):
                    self.input_reason = "Install a libei build with monitor mapping and ping support, plus libxkbcommon, for EIS input."
            if candidate is not None:
                self.layout.close()
                self.layout = None
                self.eis = candidate
                self.eis.session_check = self.require_session
                try:
                    result, descriptors = self.bus.call_with_unix_fd_list_sync(PORTAL, DESKTOP, REMOTE,
                        "ConnectToEIS", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType.new("(h)"),
                        Gio.DBusCallFlags.NONE, ctx.remaining(1000), None, None)
                    handle = result.unpack()[0]
                    if descriptors is None or not integer(handle, 0, descriptors.get_length() - 1):
                        raise Failure("portal_protocol", "The portal did not provide a valid EIS file descriptor.")
                    fd = descriptors.get(handle)
                    descriptors = None
                    ready = self.eis.connect(fd, self.streams, ctx)
                    self.eis_generation = self.eis.generation
                    if ready:
                        for stream in self.streams:
                            self.eis.display(stream)
                except Failure:
                    raise
                except Exception:
                    ctx.check()
                    raise Failure("eis_unavailable", "The desktop EIS input connection failed; its portal grant was closed.")
            else:
                self.layout.bind(ctx)
                self.input_reason = self.layout.reason
                if self.layout.available and self.granted_devices & 2:
                    # GNOME's legacy virtual pointer is created lazily. A zero
                    # continuous axis, without finish, creates it without moving,
                    # clicking or scrolling; zero discrete steps are invalid.
                    self.notify("NotifyPointerAxis", "(oa{sv}dd)", (0.0, 0.0), ctx)
                    # Do compositor work after publishing the new seat capability
                    # and before returning setup. A Notify acknowledgement is not
                    # confirmation that every Wayland client consumed the change.
                    for stream in self.streams:
                        self.capture(stream, ctx)
            self.require_session(ctx)
            self.permission = "granted"
            return {"state": self.state(ctx, probe=False), "automaticInstall": False}
        except Exception:
            self.close()
            raise

    def stream(self, display_id, ctx):
        self.require_session(ctx)
        if display_id is None:
            if len(self.streams) != 1:
                raise Failure("display_required", "Select display_id from computer_info when several monitors are shared.")
            return self.streams[0]
        for stream in self.streams:
            if stream["display"]["id"] == display_id:
                return stream
        raise Failure("unknown_display", "Choose a monitor from the current Wayland portal session.")

    def capture(self, stream, ctx):
        self.require_session(ctx)
        eis_generation = None
        pipeline = None
        fd = None
        try:
            self.check_capture_identity()
            if self.eis is not None:
                eis_generation = self.eis.generation
            # The handle in the D-Bus reply is an INDEX into UnixFDList. It is
            # never a process fd. get() gives us a caller-owned duplicate.
            result, fd_list = self.bus.call_with_unix_fd_list_sync(PORTAL, DESKTOP, SCREEN,
                "OpenPipeWireRemote", GLib.Variant("(oa{sv})", (self.session, {})), GLib.VariantType.new("(h)"),
                Gio.DBusCallFlags.NONE, ctx.remaining(1000), None, None)
            handle = result.unpack()[0]
            if fd_list is None or not integer(handle, 0, fd_list.get_length() - 1):
                raise Failure("portal_protocol", "The portal did not provide a valid PipeWire file descriptor.")
            fd = fd_list.get(handle)
            fd_list = None
            pipeline = Gst.Pipeline.new(None)
            source = Gst.ElementFactory.make("pipewiresrc")
            converter = Gst.ElementFactory.make("videoconvert")
            caps = Gst.ElementFactory.make("capsfilter")
            encoder = Gst.ElementFactory.make("pngenc")
            sink = Gst.ElementFactory.make("appsink")
            if any(element is None for element in (pipeline, source, converter, caps, encoder, sink)):
                raise Failure("dependency_missing", "Required GStreamer capture elements could not be created.")
            source.set_property("fd", fd)
            if stream["serial"] is not None:
                if source.find_property("target-object") is None:
                    raise Failure("dependency_missing", "Upgrade the GStreamer PipeWire plugin to support stable stream serials.")
                source.set_property("target-object", str(stream["serial"]))
            else:
                source.set_property("path", str(stream["node"]))
            caps.set_property("caps", Gst.Caps.from_string("video/x-raw,format=RGB"))
            encoder.set_property("snapshot", True)
            sink.set_property("sync", False)
            sink.set_property("max-buffers", 1)
            sink.set_property("drop", True)
            for element in (source, converter, caps, encoder, sink):
                pipeline.add(element)
            for left, right in ((source, converter), (converter, caps), (caps, encoder), (encoder, sink)):
                if not left.link(right):
                    raise Failure("capture_failed", "The PipeWire capture pipeline could not be linked.")
            bus = pipeline.get_bus()
            if pipeline.set_state(Gst.State.PLAYING) == Gst.StateChangeReturn.FAILURE:
                raise Failure("capture_failed", "The PipeWire capture pipeline could not start.")
            while True:
                self.require_session(ctx)
                sample = sink.emit("try-pull-sample", min(ctx.remaining(), 50) * Gst.MSECOND)
                if sample is not None:
                    buffer = sample.get_buffer()
                    if buffer is None or not 33 <= buffer.get_size() <= MAX_PNG:
                        raise Failure("output_too_large", "Wayland PNG capture exceeded its size limit.")
                    data = buffer.extract_dup(0, buffer.get_size())
                    width, height = png_geometry(data)
                    self.require_session(ctx)
                    self.check_capture_identity()
                    if stream.get("captured") and (width, height) != (stream["display"]["width"], stream["display"]["height"]):
                        self.invalidate_unstable_streams()
                    logical = stream["logical"]
                    stream["display"].update(width=width, height=height,
                        scaleX=width / logical[0] if logical else 1, scaleY=height / logical[1] if logical else 1)
                    if self.eis is not None:
                        self.eis.check(ctx, eis_generation, "capture")
                        if self.eis.region(stream["mapping"]) is not None:
                            self.eis.display(stream)
                    stream["captured"] = True
                    return {"data": base64.b64encode(data).decode("ascii"), "mimeType": "image/png",
                        "display": dict(stream["display"]), "capturedAt": int(time.time() * 1000)}
                message = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.EOS)
                if message is not None:
                    raise Failure("capture_failed", "The PipeWire stream stopped before a screenshot was available.")
        except Failure as error:
            if error.code != "display_changed":
                self.close()
            else:
                self.needs_setup = True
            raise
        except Exception:
            self.close()
            ctx.check()
            raise Failure("capture_failed", "Could not capture the selected authorized Wayland monitor.")
        finally:
            if pipeline is not None:
                pipeline.set_state(Gst.State.NULL)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass

    def act(self, action, display, ctx):
        if not isinstance(display, dict):
            raise Failure("invalid_display", "Wayland input needs a captured monitor identity.")
        stream = self.stream(display.get("id"), ctx)
        self.require_input(ctx)
        if display.get("instanceId") != stream["display"]["instanceId"]:
            raise Failure("display_changed", "The Wayland session changed; capture a new frame.")
        expected = {key: display.get(key) for key in ("id", "instanceId", "x", "y", "width", "height", "scaleX", "scaleY", "rotation")}
        if any(expected[key] != stream["display"][key] for key in expected):
            raise Failure("display_changed", "The Wayland monitor geometry changed; capture a new frame.")
        symbols = validate_action(action, stream["display"])
        supported = self.input_actions()
        if action["type"] not in supported:
            raise Failure("keyboard_unavailable" if action["type"] in ("key", "text") else "input_unavailable",
                "This input action is unavailable in the current portal devices and keyboard map. Check the supported actions in computer_info.")
        # A new PipeWire connection verifies current negotiated geometry and
        # rejects stale frames after a monitor resize before the first event.
        self.capture(stream, ctx)
        if any(expected[key] != stream["display"][key] for key in expected):
            raise Failure("display_changed", "The Wayland monitor geometry changed; capture a new frame.")
        if self.eis is not None:
            try:
                return self.eis.act(action, stream, display, symbols, ctx)
            except Failure as error:
                if error.code == "display_changed":
                    self.needs_setup = True
                    self.invalidate_unstable_streams()
                elif error.code not in ("keyboard_modifiers_active", "keymap_character_unsupported", "keyboard_state_changed"):
                    self.close()
                raise
            except Exception:
                self.close()
                raise
        kind = action["type"]
        def move(x, y):
            self.notify("NotifyPointerMotionAbsolute", "(oa{sv}udd)",
                (stream["node"], x / display["scaleX"], y / display["scaleY"]), ctx)
        def button(code, pressed):
            if pressed:
                self.held_buttons.append(code)
            self.notify("NotifyPointerButton", "(oa{sv}iu)", (code, 1 if pressed else 0), ctx)
            if not pressed:
                self.held_buttons.remove(code)
        try:
            if kind == "move":
                move(action["x"], action["y"])
            elif kind == "click":
                move(action["x"], action["y"])
                code = {"left": 272, "right": 273, "middle": 274}[action.get("button", "left")]
                for index in range(action.get("clicks", 1)):
                    if index:
                        ctx.sleep(0.08)
                    button(code, True)
                    button(code, False)
            elif kind == "drag":
                move(action["fromX"], action["fromY"])
                button(272, True)
                duration = action.get("durationMs", 400)
                steps = max(2, min(50, math.ceil(duration / 25)))
                for index in range(1, steps + 1):
                    ctx.sleep(duration / 1000 / steps)
                    move(action["fromX"] + (action["toX"] - action["fromX"]) * index / steps,
                        action["fromY"] + (action["toY"] - action["fromY"]) * index / steps)
                button(272, False)
            elif kind == "scroll":
                if "x" in action:
                    move(action["x"], action["y"])
                direction = action["direction"]
                self.notify("NotifyPointerAxisDiscrete", "(oa{sv}ui)",
                    (0 if direction in ("up", "down") else 1,
                     action.get("amount", 3) * (-1 if direction in ("up", "left") else 1)), ctx)
            ctx.sleep(0.02)
        finally:
            if not self.release_inputs():
                self.close(release=False)
                raise Failure("input_cleanup_failed", "Input release could not be confirmed; the portal session was closed.")
        return {"submitted": True, "verified": False,
            "verification": "Capture the result to verify application behavior.", "inputBackend": "Wayland RemoteDesktop portal"}


def emit(value):
    try:
        with OUTPUT_LOCK:
            sys.stdout.write(json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n")
            sys.stdout.flush()
    except (BrokenPipeError, OSError):
        STOP.set()


def run():
    work = queue.Queue(maxsize=1)
    portal = Portal()
    loop = GLib.MainLoop() if GLib is not None else None
    busy = threading.Event()
    def reader():
        pending = bytearray()
        try:
            while not STOP.is_set():
                chunk = os.read(sys.stdin.fileno(), 16384)
                if not chunk:
                    break
                pending.extend(chunk)
                if len(pending) > MAX_REQUEST:
                    break
                while b"\n" in pending:
                    line, _, pending = pending.partition(b"\n")
                    try:
                        request = json.loads(line)
                        if (not isinstance(request, dict) or not isinstance(request.get("id"), str)
                                or not re.fullmatch(r"[a-zA-Z0-9._:-]{1,128}", request["id"])):
                            raise ValueError()
                        # The flushed response can reach Node before the worker
                        # clears its busy flag. Permit one queued request while
                        # retaining a single executing worker; never reject an
                        # otherwise sequential call merely for that flush race.
                        if not work.empty():
                            emit({"id": request["id"], "ok": False, "error": {"code": "computer_busy", "message": "Another Wayland operation is in progress."}})
                        else:
                            work.put_nowait(request)
                    except (ValueError, UnicodeDecodeError, queue.Full):
                        STOP.set()
                        break
        except OSError:
            pass
        finally:
            STOP.set()

    def worker():
        last_activity = time.monotonic()
        try:
            while not STOP.is_set():
                try:
                    request = work.get(timeout=0.1)
                except queue.Empty:
                    portal.poll()
                    if portal.active and time.monotonic() - last_activity >= IDLE_SECONDS:
                        portal.close()
                        portal.last_reason = "The Wayland session expired after five idle minutes. Run computer_setup to authorize a new session."
                    continue
                busy.set()
                try:
                    ctx = Context(request.get("timeoutMs", 30000))
                    operation = request.get("operation")
                    if operation == "inspect":
                        result = portal.state(ctx)
                    elif operation == "setup":
                        result = portal.setup(ctx)
                    elif operation == "screenshot":
                        result = portal.capture(portal.stream(request.get("displayId"), ctx), ctx)
                    elif operation == "act":
                        result = portal.act(request.get("action"), request.get("display"), ctx)
                    elif operation == "close":
                        portal.close()
                        result = {"closed": True}
                    else:
                        raise Failure("unknown_operation", "Unsupported Wayland helper operation.")
                    ctx.check()
                    emit({"id": request["id"], "ok": True, "result": result})
                except Failure as error:
                    if error.code in ("cancelled", "timeout"):
                        portal.close()
                    response = {"code": error.code, "message": error.message}
                    if error.details:
                        response["details"] = error.details
                    emit({"id": request["id"], "ok": False, "error": response})
                except Exception:
                    portal.close()
                    emit({"id": request["id"], "ok": False, "error": {
                        "code": "wayland_helper_failed", "message": "The Wayland helper failed and closed its portal session."}})
                finally:
                    last_activity = time.monotonic()
                    busy.clear()
        finally:
            portal.close()
            if portal.bus is not None:
                try:
                    portal.bus.close_sync(None)
                except Exception:
                    pass
            STOP.set()
            if loop is not None:
                GLib.idle_add(loop.quit)

    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    threading.Thread(target=reader, daemon=True).start()
    executor = threading.Thread(target=worker, daemon=True)
    executor.start()
    if loop is not None:
        loop.run()
    else:
        executor.join()
    executor.join(timeout=1)


if __name__ == "__main__":
    run()
`;
