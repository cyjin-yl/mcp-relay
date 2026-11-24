"""Protocol and input-fence tests; the native compositor smoke is separate."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

COMPUTER = Path(__file__).parents[1] / "src/computer"
HELPER = "\n".join((COMPUTER / name).read_text().split("String.raw`", 1)[1].rsplit("`;", 1)[0]
                   for name in ("wayland-eis-helper.ts", "wayland-layout-helper.ts", "wayland-helper.ts"))
MODULE = {"__name__": "wayland_helper_test"}
exec(compile(HELPER, "embedded-wayland-helper.py", "exec"), MODULE)
Failure, Context, Portal = (MODULE[name] for name in ("Failure", "Context", "Portal"))
DISPLAY = {"id": "wayland:24", "instanceId": "one:77", "x": 0, "y": 0,
           "width": 800, "height": 600, "scaleX": 2, "scaleY": 2, "rotation": 0}


class FakeBus:
    def __init__(self, fail=False):
        self.calls = []
        self.fail = fail

    def call_sync(self, *arguments):
        self.calls.append(arguments)
        if self.fail:
            raise RuntimeError("injected DBus failure")

    def is_closed(self):
        return False


class HelperInputTests(unittest.TestCase):
    def setUp(self):
        self.portal = Portal()
        self.portal.active = True
        self.portal.granted_devices = 3
        self.portal.session = "/session/owned"
        self.portal.epoch = "one"
        self.portal.streams = [{"node": 24, "serial": 77, "logical": (400, 300),
                                "display": dict(DISPLAY)}]
        self.portal.capture = lambda *_: None
        self.events = []
        self.portal.notify = lambda method, signature, arguments, ctx: self.events.append((method, arguments))
        self.portal.bus = FakeBus()
        self.portal.layout = types.SimpleNamespace(available=True, reason="Fixture layout", check=lambda ctx: ctx.check(), close=lambda: None)
        self.globals = patch.dict(MODULE, {
            "Gio": types.SimpleNamespace(DBusCallFlags=types.SimpleNamespace(NONE=0)),
            "GLib": types.SimpleNamespace(Variant=lambda signature, values: (signature, values)),
        })
        self.globals.start()

    def tearDown(self):
        self.globals.stop()

    def failure(self, code, action, display=DISPLAY):
        with self.assertRaises(Failure) as caught:
            self.portal.act(action, copy.deepcopy(display), Context(2000))
        self.assertEqual(caught.exception.code, code)

    def test_scaled_coordinates_are_relative_to_the_selected_stream(self):
        self.portal.act({"type": "click", "x": 600, "y": 400}, dict(DISPLAY), Context(2000))
        self.assertEqual(self.events[0], ("NotifyPointerMotionAbsolute", (24, 300.0, 200.0)))
        self.assertEqual(self.events[1:], [("NotifyPointerButton", (272, 1)), ("NotifyPointerButton", (272, 0))])
        self.assertEqual(self.portal.held_buttons, [])

    def test_stale_session_fails_before_capture_or_input(self):
        self.portal.capture = lambda *_: self.fail("must not capture a stale session")
        self.failure("display_changed", {"type": "click", "x": 0, "y": 0}, dict(DISPLAY, instanceId="old:77"))
        self.assertEqual(self.events, [])

    def test_resize_fails_before_first_input(self):
        def resized(stream, _ctx):
            stream["display"]["width"] = 1000
        self.portal.capture = resized
        self.failure("display_changed", {"type": "click", "x": 20, "y": 20})
        self.assertEqual(self.events, [])

    def test_entire_text_is_validated_before_any_input(self):
        self.portal.capture = lambda *_: self.fail("unsupported text must be rejected before capture")
        for text in ("partial must not type 中文", "partial must not type\nsubmit", "partial must not type\ttarget", "partial\x00"):
            self.failure("text_unsupported", {"type": "text", "text": text})
        self.assertEqual(self.events, [])

    def test_legacy_keyboard_is_not_advertised_or_partially_sent(self):
        self.portal.capture = lambda *_: self.fail("unavailable keyboard must fail before capture")
        state = self.portal.state(Context(2000), probe=False)
        self.assertEqual(state["actions"], ["move", "click", "drag", "scroll"])
        self.assertEqual(state["details"]["inputTransport"], "gnome-legacy")
        self.assertIn("pointer actions only", state["details"]["textSupport"])
        for action in ({"type": "text", "text": "Relay 42 !@#:/[]{}?"},
                       {"type": "key", "keys": ["ctrl", "a"]}):
            self.failure("keyboard_unavailable", action)
        self.assertEqual(self.events, [])
        self.assertTrue(self.portal.active)

    def test_out_of_range_and_boolean_coordinates_never_send_input(self):
        for coordinate in (800, -1, True, 1.5):
            self.failure("out_of_bounds", {"type": "move", "x": coordinate, "y": 0})
        self.assertEqual(self.events, [])

    def test_cancelled_drag_releases_possibly_pressed_button(self):
        def notify(method, signature, arguments, ctx):
            self.events.append((method, arguments))
            if len(self.events) == 2:
                raise Failure("cancelled", "Injected cancellation during button down")
        self.portal.notify = notify
        self.failure("cancelled", {"type": "drag", "fromX": 20, "fromY": 20, "toX": 40, "toY": 40})
        self.assertEqual([call[4][1][2:] for call in self.portal.bus.calls], [(272, 0)])
        self.assertEqual(self.portal.held_buttons, [])

    def test_release_failure_closes_the_entire_grant(self):
        self.portal.bus = FakeBus(fail=True)
        def notify(method, signature, arguments, ctx):
            self.events.append((method, arguments))
            if len(self.events) == 2:
                raise Failure("portal_unavailable", "Injected failure after button may have applied")
        self.portal.notify = notify
        self.failure("input_cleanup_failed", {"type": "click", "x": 20, "y": 20})
        self.assertFalse(self.portal.active)
        self.assertIsNone(self.portal.session)
        self.assertTrue(any(call[2:4] == (MODULE["SESSION"], "Close") for call in self.portal.bus.calls))

    def test_all_keys_are_validated_before_chord_starts(self):
        self.failure("unsupported_key", {"type": "key", "keys": ["ctrl", "unexpected-key"]})
        self.assertEqual(self.events, [])

    def test_multiple_monitors_require_an_explicit_capture_target(self):
        self.portal.streams.append({"node": 25, "display": dict(DISPLAY, id="wayland:25")})
        with self.assertRaises(Failure) as caught:
            self.portal.stream(None, Context(2000))
        self.assertEqual(caught.exception.code, "display_required")

    def test_pointer_only_consent_keeps_capture_and_pointer_actions(self):
        self.portal.granted_devices = 2
        state = self.portal.state(Context(2000), probe=False)
        self.assertTrue(state["available"])
        self.assertEqual(state["actions"], ["move", "click", "drag", "scroll"])
        self.assertEqual(state["permissions"]["input"], "granted")
        self.portal.granted_devices = 0
        state = self.portal.state(Context(2000), probe=False)
        self.assertTrue(state["available"])
        self.assertEqual(state["actions"], [])
        self.assertEqual(state["inputKind"], "none")

    def eis_fixture(self):
        return types.SimpleNamespace(generation=2, pump=lambda: None,
            release=lambda: True, close=lambda: None)

    def test_topology_change_without_serial_closes_before_opening_pipewire(self):
        self.portal.streams[0]["serial"] = None
        self.portal.eis_generation = 1
        self.portal.eis = self.eis_fixture()
        with self.assertRaises(Failure) as caught:
            Portal.capture(self.portal, self.portal.streams[0], Context(2000))
        self.assertEqual(caught.exception.code, "display_changed")
        self.assertTrue(caught.exception.details["setupRequired"])
        self.assertFalse(self.portal.active)
        self.assertIsNone(self.portal.session)

    def test_stable_serial_does_not_require_a_new_capture_grant(self):
        self.portal.eis_generation = 1
        self.portal.eis = self.eis_fixture()
        self.portal.refresh_eis()
        self.assertTrue(self.portal.active)
        self.assertTrue(self.portal.needs_setup)
        self.assertEqual(self.portal.eis_generation, 2)

    def test_legacy_layout_change_without_serial_closes_capture_grant(self):
        self.portal.streams[0]["serial"] = None
        self.portal.layout.fenced = types.SimpleNamespace(is_set=lambda: True)
        with self.assertRaises(Failure) as caught:
            self.portal.check_capture_identity()
        self.assertEqual(caught.exception.code, "display_changed")
        self.assertFalse(self.portal.active)


class HelperProtocolTests(unittest.TestCase):
    def test_sequential_inspection_has_no_flush_race_and_eof_exits(self):
        child = subprocess.Popen([sys.executable, "-u", "-c", HELPER], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={"PATH": os.defpath})
        try:
            for number in range(40):
                child.stdin.write(json.dumps({"id": str(number), "operation": "inspect", "timeoutMs": 3000}) + "\n")
                child.stdin.flush()
                result = json.loads(child.stdout.readline())
                self.assertEqual(result["id"], str(number))
                self.assertTrue(result["ok"])
                self.assertFalse(result["result"]["available"])
                self.assertTrue(result["result"]["details"]["setupRequired"])
            child.stdin.close()
            child.wait(timeout=3)
            self.assertEqual(child.returncode, 0)
            self.assertEqual(child.stderr.read(), "")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            child.stdout.close()
            child.stderr.close()


if __name__ == "__main__":
    unittest.main()
