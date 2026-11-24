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
        return {"name": node.name or "", "role": node.getRoleName(),
                "states": [str(x) for x in node.getState().getStates()]}
    except Exception:
        return {"name": "<defunct>"}


def actionable(node):
    import pyatspi

    try:
        states = node.getState()
        return states.contains(pyatspi.STATE_SHOWING) and states.contains(pyatspi.STATE_SENSITIVE)
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
        share = [n for n in nodes if (n.name or "").replace("_", "").strip().lower() == "share"]
        cancel = [n for n in nodes if (n.name or "").replace("_", "").strip().lower() == "cancel"]
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


if __name__ == "__main__":
    guard()
    mode = sys.argv[1]
    if mode == "fixture":
        fixture()
    elif mode in ("allow", "cancel", "absent"):
        consent(mode)
    elif mode == "png":
        png()
    else:
        raise RuntimeError("Unsupported harness mode")
