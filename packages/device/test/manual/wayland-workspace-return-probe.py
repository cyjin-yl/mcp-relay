#!/usr/bin/env python3
"""Measure recovery-viewer prerequisites on the owned headless GNOME desktop.

This probe does not enable or accept workspace recovery. GTK frame timings are
recorded as observations, not proof that a buffer was presented by the compositor.
The private Mutter input session supplies a fixture keyboard, not production input.
"""
import json
import os
import pathlib
import subprocess
import sys
import time

OUT = pathlib.Path(os.environ["RELAY_MAP_PROBE_DIR"])
if (os.environ.get("RELAY_MAP_PROBE_DESKTOP") != "owned-headless-mutter"
        or os.environ.get("XDG_RUNTIME_DIR") != str(OUT / "runtime")
        or os.environ.get("DISPLAY")
        or not os.environ.get("DBUS_SESSION_BUS_ADDRESS")):
    raise RuntimeError("This probe requires its marked, private, native Wayland desktop")
OUT.mkdir(parents=True, exist_ok=True)


def write_json(name, value):
    path = OUT / (name + ".json")
    temporary = OUT / (name + ".tmp")
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(path)


def fixture(mode):
    import gi
    gi.require_version("Gtk", "3.0")
    from gi.repository import GLib
    GLib.set_prgname("relay-foreground-fixture" if mode == "foreground" else "relay-recovery-viewer-probe")
    from gi.repository import Gtk, Gdk
    window = Gtk.Window(title="Relay foreground fixture" if mode == "foreground" else "Relay recovery viewer probe")
    window.set_default_size(500, 300)
    if mode != "foreground":
        window.set_focus_on_map(False)
        if mode == "no-accept":
            window.set_accept_focus(False)
    window.add(Gtk.Label(label="Local foreground" if mode == "foreground" else "Recovered workspace"))
    display = Gdk.Display.get_default()
    if "Wayland" not in display.__gtype__.name:
        raise RuntimeError("The probe did not get a native Wayland display")
    result = {"mode": mode, "pid": os.getpid(), "backend": display.__gtype__.name, "events": [], "frames": []}

    def state(*_):
        keyboard = display.get_default_seat().get_keyboard()
        result["events"].append({"at": time.monotonic(), "mapped": window.get_mapped(),
                                 "visible": window.get_visible(), "focused": window.is_active(),
                                 "keyboardPresent": keyboard is not None})
        write_json(mode, result)

    window.connect("notify::is-active", state)
    window.connect("map-event", state)
    window.connect("unmap-event", state)

    def frames():
        clock = window.get_frame_clock()
        if clock:
            counter = clock.get_frame_counter()
            for index in range(max(clock.get_history_start(), counter - 3), counter + 1):
                timings = clock.get_timings(index)
                if timings and timings.get_complete():
                    item = {"counter": index, "complete": timings.get_complete(),
                            "presentation": timings.get_presentation_time(), "frame": timings.get_frame_time()}
                    if item not in result["frames"]:
                        result["frames"].append(item)
            result["frames"] = result["frames"][-16:]
        state()
        return True

    window.connect("destroy", Gtk.main_quit)
    window.show_all()  # Deliberately no present(), activation token or focus request.
    GLib.timeout_add(100, frames)
    GLib.timeout_add(15000, lambda: (Gtk.main_quit(), False)[1])
    Gtk.main()


def measure():
    from gi.repository import Gio, GLib
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    destination = "org.gnome.Mutter.RemoteDesktop"
    interface = destination + ".Session"
    session = None
    processes = []

    def call(path, iface, method, parameters=None):
        return connection.call_sync(destination, path, iface, method, parameters,
                                    None, Gio.DBusCallFlags.NONE, 3000, None)

    def start(mode):
        log = (OUT / (mode + ".log")).open("w")
        process = subprocess.Popen([sys.executable, __file__, mode],
                                   env=dict(os.environ, WAYLAND_DEBUG="1"),
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append((process, log))
        return process

    def read(mode):
        try:
            return json.loads((OUT / (mode + ".json")).read_text())
        except (OSError, ValueError):
            return None

    def protocol(mode):
        value = (OUT / (mode + ".log")).read_text()
        lines = value.splitlines()
        return {
            "presentationAdvertised": any('"wp_presentation"' in x and ".global(" in x for x in lines),
            "presentationBound": any('"wp_presentation"' in x and ".bind(" in x for x in lines),
            "presentationFeedbackEvents": sum(".presented(" in x for x in lines),
            "activationRequests": sum(".activate(" in x or ".request_focus(" in x for x in lines),
            "keyboardEnterEvents": sum("wl_keyboard@" in x and ".enter(" in x for x in lines),
            "keyboardLeaveEvents": sum("wl_keyboard@" in x and ".leave(" in x for x in lines),
        }

    try:
        session = call("/org/gnome/Mutter/RemoteDesktop", destination, "CreateSession").unpack()[0]
        call(session, interface, "Start")
        # A headless compositor has no physical keyboard. A complete Shift pair
        # creates an owned virtual keyboard before any fixture window is mapped.
        call(session, interface, "NotifyKeyboardKeycode", GLib.Variant("(ub)", (42, True)))
        call(session, interface, "NotifyKeyboardKeycode", GLib.Variant("(ub)", (42, False)))
        time.sleep(0.2)
        start("foreground")
        deadline = time.monotonic() + 7
        while time.monotonic() < deadline:
            first = read("foreground")
            if first and first["events"][-1]["focused"] and first["events"][-1]["keyboardPresent"]:
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("foreground_never_focused_with_fixture_keyboard")
        start_time = time.monotonic()
        mode = os.environ.get("RELAY_MAP_PROBE_MODE", "viewer")
        if mode not in ("viewer", "no-accept"):
            raise RuntimeError("Unknown probe mode")
        start(mode)
        time.sleep(3)
        first, second = read("foreground"), read(mode)
        if not second or not any(x["mapped"] and x["visible"] for x in second["events"]):
            raise RuntimeError("viewer_never_mapped")
        result = {
            "foreground": first,
            "viewer": second,
            "foregroundFocusedBeforeViewer": True,
            "foregroundLostFocus": any(x["at"] >= start_time and not x["focused"] for x in first["events"]),
            "viewerTookFocus": any(x["focused"] for x in second["events"]),
            "startedViewer": start_time,
            "foregroundProtocol": protocol("foreground"),
            "viewerProtocol": protocol(mode),
            "workspaceAcceptance": False,
        }
        write_json("result", result)
        summary = {key: value for key, value in result.items() if key not in ("foreground", "viewer")}
        summary.update({"mode": mode, "viewerBackend": second["backend"], "viewerFrames": second["frames"]})
        print(json.dumps(summary, sort_keys=True), flush=True)
    except BaseException as error:
        failure = {"errorClass": type(error).__name__, "message": str(error), "workspaceAcceptance": False}
        write_json("failure", failure)
        print(json.dumps(failure), flush=True)
        raise
    finally:
        for process, _log in processes:
            process.terminate()
        for process, log in processes:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            log.close()
        if session:
            call(session, interface, "Stop")


if len(sys.argv) > 1:
    fixture(sys.argv[1])
else:
    measure()
