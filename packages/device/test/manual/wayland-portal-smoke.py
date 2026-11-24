#!/usr/bin/env python3
"""Native Wayland fixture and consent driver, only for the disposable CI desktop.

The fixture receives ordinary GTK events from the real compositor.  The consent
driver activates the actual portal dialog through AT-SPI; it does not alter the
permission store or replace any portal implementation.
"""

import io
import json
import os
import sys
import time


def guard():
    if os.environ.get("RELAY_WAYLAND_NATIVE_TEST") != "nested-mutter-private-bus":
        raise RuntimeError("This harness requires its explicitly marked disposable desktop")
    runtime = os.environ.get("XDG_RUNTIME_DIR", "")
    evidence = os.environ.get("RELAY_NATIVE_EVIDENCE_DIR", "")
    if not evidence.startswith("/") or runtime != evidence + "/runtime":
        raise RuntimeError("The harness must use its own runtime directory")
    if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
        raise RuntimeError("A private session bus is required")


def fixture():
    import gi

    gi.require_version("Gtk", "4.0")
    gi.require_version("Gdk", "4.0")
    from gi.repository import Gdk, GLib, Gtk

    Gtk.init()
    display = Gdk.Display.get_default()
    display_type = display.__gtype__.name
    if "Wayland" not in display_type:
        raise RuntimeError("Fixture is not a native Wayland client: " + display_type)
    if os.environ.get("DISPLAY"):
        raise RuntimeError("Fixture must not have an X11 fallback")

    loop = GLib.MainLoop()
    window = Gtk.Window(title="Relay native Wayland fixture")
    window.set_default_size(640, 480)
    window.set_decorated(False)
    fixed = Gtk.Fixed()
    window.set_child(fixed)
    canvas = Gtk.DrawingArea()
    canvas.set_size_request(640, 480)
    fixed.put(canvas, 0, 0)
    entry = Gtk.Entry()
    entry.set_size_request(560, 40)
    fixed.put(entry, 20, 20)
    button = Gtk.Button(label="Native click target")
    button.set_size_request(200, 45)
    fixed.put(button, 20, 80)
    state = {
        "displayType": display_type,
        "text": "",
        "clicks": 0,
        "drags": 0,
        "motion": 0,
        "scrollX": 0.0,
        "scrollY": 0.0,
        "buttons": [],
        "keys": [],
        "logicalWidth": 0,
        "logicalHeight": 0,
        "gdkScale": 1,
    }
    last = None

    def report():
        nonlocal last
        state["logicalWidth"] = window.get_width()
        state["logicalHeight"] = window.get_height()
        state["gdkScale"] = window.get_scale_factor()
        serialized = json.dumps(state, sort_keys=True, ensure_ascii=False)
        if serialized != last:
            print(serialized, flush=True)
            last = serialized
        return True

    def draw(_area, ctx, _width, _height):
        ctx.set_source_rgb(36 / 255, 91 / 255, 160 / 255)
        ctx.paint()
        color = (29, 181, 83) if state["clicks"] else (211, 51, 63)
        ctx.set_source_rgb(*(v / 255 for v in color))
        ctx.rectangle(30, 140, 100, 25)
        ctx.fill()

    canvas.set_draw_func(draw)

    def clicked(_button):
        state["clicks"] += 1
        canvas.queue_draw()
        report()

    button.connect("clicked", clicked)
    entry.connect("changed", lambda item: (state.update(text=item.get_text()), report()))
    click = Gtk.GestureClick()
    click.set_button(0)

    def pressed(gesture, _count, _x, _y):
        value = gesture.get_current_button()
        state["buttons"] = sorted(set(state["buttons"]) | {value})
        report()

    def released(gesture, _count, _x, _y):
        value = gesture.get_current_button()
        state["buttons"] = [v for v in state["buttons"] if v != value]
        report()

    click.connect("pressed", pressed)
    click.connect("released", released)
    canvas.add_controller(click)
    motion = Gtk.EventControllerMotion()

    def moved(controller, x, y):
        state["motion"] += 1
        modifiers = controller.get_current_event_state()
        # Actual event state, rather than our own press bookkeeping, detects a
        # stuck compositor button after a helper crash.
        if modifiers & Gdk.ModifierType.BUTTON1_MASK:
            state["drags"] += 1
        state["lastPointer"] = [round(x, 2), round(y, 2)]
        report()

    motion.connect("motion", moved)
    canvas.add_controller(motion)
    scroll = Gtk.EventControllerScroll.new(Gtk.EventControllerScrollFlags.BOTH_AXES)

    def scrolled(_controller, dx, dy):
        state["scrollX"] += dx
        state["scrollY"] += dy
        report()
        return True

    scroll.connect("scroll", scrolled)
    canvas.add_controller(scroll)
    keys = Gtk.EventControllerKey()
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)

    def key_pressed(_controller, keyval, _keycode, _modifiers):
        name = Gdk.keyval_name(keyval) or str(keyval)
        state["keys"] = sorted(set(state["keys"]) | {name})
        report()
        return False

    def key_released(_controller, keyval, _keycode, _modifiers):
        name = Gdk.keyval_name(keyval) or str(keyval)
        state["keys"] = [v for v in state["keys"] if v != name]
        report()

    keys.connect("key-pressed", key_pressed)
    keys.connect("key-released", key_released)
    window.add_controller(keys)
    window.connect("close-request", lambda _window: (loop.quit(), False)[1])

    def command(_source, condition):
        if condition & GLib.IO_HUP:
            loop.quit()
            return False
        line = sys.stdin.readline()
        if not line:
            loop.quit()
            return False
        request = json.loads(line)
        if request.get("operation") == "present":
            window.present()
        elif request.get("operation") == "quit":
            loop.quit()
            return False
        else:
            raise RuntimeError("Unsupported fixture command")
        return True

    GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, command)
    GLib.timeout_add(50, report)
    window.fullscreen()
    window.present()
    loop.run()


def portal_nodes():
    import pyatspi

    # Limit traversal to the actual portal backend in this private a11y bus.
    desktop = pyatspi.Registry.getDesktop(0)
    found = []
    for app in desktop:
        try:
            if "portal" not in (app.name or "").lower():
                continue
            pending = [(app, 0)]
            while pending and len(found) < 300:
                item, depth = pending.pop(0)
                if depth > 15:
                    continue
                found.append(item)
                pending.extend((child, depth + 1) for child in item if child is not None)
        except Exception:
            continue
    return found


def node_details(node):
    try:
        details = {"name": node.name or "", "role": node.getRoleName(),
                   "states": [str(x) for x in node.getState().getStates()]}
        try:
            action = node.queryAction()
            details["actions"] = [action.getName(i) for i in range(action.nActions)]
        except Exception:
            pass
        return details
    except Exception:
        return {"name": "<defunct>"}


def actionable(node):
    import pyatspi

    try:
        states = node.getState()
        if not states.contains(pyatspi.STATE_VISIBLE) or not states.contains(pyatspi.STATE_SENSITIVE):
            return False
        # GTK 4.8 exports SHOWING on its toplevel, but only VISIBLE on the
        # descendant buttons. Require that actual visible toplevel rather
        # than treating this toolkit difference as a missing consent dialog.
        ancestor = node
        for _depth in range(16):
            if ancestor is None:
                break
            if ancestor.getState().contains(pyatspi.STATE_SHOWING):
                return True
            ancestor = ancestor.parent
        return False
    except Exception:
        return False


def activate(node):
    try:
        action = node.queryAction()
        for index in range(action.nActions):
            if action.getName(index) in ("click", "press", "activate", "toggle"):
                return bool(action.doAction(index))
    except Exception:
        pass
    return False


def consent(mode):
    import pyatspi

    deadline = time.monotonic() + 20
    absent_since = None
    acted = set()
    while time.monotonic() < deadline:
        nodes = portal_nodes()
        def button_named(node, expected):
            words = set((node.name or "").replace("_", "").strip().lower().split())
            return words == {expected} and node.getRoleName() in ("push button", "button")

        share = [n for n in nodes if button_named(n, "share")]
        cancel = [n for n in nodes if button_named(n, "cancel")]
        showing = [n for n in share + cancel if actionable(n)]
        if mode == "absent":
            if not showing:
                absent_since = absent_since or time.monotonic()
                if time.monotonic() - absent_since > 0.5:
                    print(json.dumps({"ok": True, "dialogAbsent": True}), flush=True)
                    return
            else:
                absent_since = None
            time.sleep(0.1)
            continue
        if mode == "cancel":
            for node in cancel:
                if actionable(node) and activate(node):
                    print(json.dumps({"ok": True, "dialogAction": "Cancel"}), flush=True)
                    return
        else:
            # The only toggle controls in our MONITOR-only, non-persistent
            # request are monitor selection and remote interaction. Do not
            # press unrelated buttons or grant persistent permissions.
            for node in nodes:
                if not actionable(node):
                    continue
                name = (node.name or "").strip().lower()
                role = node.getRoleName().lower()
                if "remember" in name or "clipboard" in name:
                    continue
                if role not in ("toggle button", "check box", "switch"):
                    continue
                states = node.getState()
                if states.contains(pyatspi.STATE_CHECKED) or states.contains(pyatspi.STATE_SELECTED):
                    continue
                # Some older GTK4 switches lack their row's accessible name.
                # Their accessible object path still uniquely identifies them.
                identity = str(node)
                if identity not in acted and activate(node):
                    acted.add(identity)
                    time.sleep(0.15)
            for node in share:
                if actionable(node) and activate(node):
                    print(json.dumps({"ok": True, "dialogAction": "Share", "toggled": len(acted)}), flush=True)
                    return
        time.sleep(0.1)
    print(json.dumps({"ok": False, "mode": mode,
                      "portalTree": [node_details(n) for n in portal_nodes()]}), flush=True)
    raise RuntimeError("Real portal consent dialog did not reach the requested state")


def png():
    from PIL import Image

    request = json.loads(sys.argv[2])
    image = Image.open(io.BytesIO(sys.stdin.buffer.read(16 * 1024 * 1024)))
    image.load()
    image = image.convert("RGB")
    samples = [list(image.getpixel((int(p[0]), int(p[1])))) for p in request]
    print(json.dumps({"width": image.width, "height": image.height, "samples": samples}))


def set_scale():
    """Temporarily change only this harness's single dummy monitor."""
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib

    if (os.environ.get("MUTTER_DEBUG_NUM_DUMMY_MONITORS") != "1"
            or os.environ.get("MUTTER_DEBUG_DUMMY_MODE_SPECS") != "1600x1200"):
        raise RuntimeError("Scale tests require the owned single-monitor dummy compositor")
    desired = float(sys.argv[2])
    if desired not in (1.0, 2.0):
        raise RuntimeError("Only the two native test scales are allowed")
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    service, path = "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig"

    def call(method, values=None):
        return bus.call_sync(service, path, service, method, values, None,
                             Gio.DBusCallFlags.NO_AUTO_START, 3000, None).unpack()

    def describe(state):
        serial, monitors, logicals, properties = state
        if len(monitors) != 1 or len(logicals) != 1:
            raise RuntimeError("Refusing to change a desktop other than the single dummy monitor")
        spec, modes, _properties = monitors[0]
        active = [mode for mode in modes if mode[6].get("is-current") is True]
        if len(active) != 1 or tuple(active[0][1:3]) != (1600, 1200):
            raise RuntimeError("Refusing to change an unexpected physical monitor mode")
        logical = logicals[0]
        if tuple(logical[:2]) != (0, 0) or logical[3] != 0 or logical[5] != [spec]:
            raise RuntimeError("Unexpected dummy monitor topology")
        if desired not in active[0][5]:
            raise RuntimeError("The actual compositor does not advertise the requested test scale")
        return serial, spec, active[0], logical, properties

    before = describe(call("GetCurrentState"))
    serial, spec, mode, logical, properties = before
    options = {}
    if properties.get("supports-changing-layout-mode") is True:
        options["layout-mode"] = GLib.Variant("u", 1)
    elif properties.get("layout-mode", 1) != 1:
        raise RuntimeError("The test requires an actual compositor logical layout")
    # Method1 is temporary, never a persistent monitor configuration.
    call("ApplyMonitorsConfig", GLib.Variant("(uua(iiduba(ssa{sv}))a{sv})",
        (serial, 1, [(0, 0, desired, 0, True, [(spec[0], mode[0], {})])], options)))
    deadline = time.monotonic() + 5
    while True:
        after = describe(call("GetCurrentState"))
        if after[3][2] == desired:
            break
        if time.monotonic() >= deadline:
            raise RuntimeError("The compositor did not apply its advertised scale")
        time.sleep(0.05)
    print(json.dumps({"ok": True, "scaleBefore": logical[2], "scaleAfter": after[3][2],
                      "serialBefore": serial, "serialAfter": after[0],
                      "physicalBefore": list(mode[1:3]), "physicalAfter": list(after[2][1:3]),
                      "modeUnchanged": mode[0] == after[2][0],
                      "layoutMode": after[4].get("layout-mode", 1)}), flush=True)


if __name__ == "__main__":
    guard()
    mode = sys.argv[1]
    if mode == "fixture":
        fixture()
    elif mode in ("allow", "cancel", "absent"):
        consent(mode)
    elif mode == "png":
        png()
    elif mode == "scale":
        set_scale()
    else:
        raise RuntimeError("Unsupported harness mode")
