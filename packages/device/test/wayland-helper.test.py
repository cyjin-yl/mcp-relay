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

    def test_printable_ascii_text_does_not_change_clipboard_or_submit(self):
        self.portal.act({"type": "text", "text": "Ab !"}, dict(DISPLAY), Context(2000))
        self.assertEqual(self.events, [("NotifyKeyboardKeysym", (symbol, state))
            for symbol in (65, 98, 32, 33) for state in (1, 0)])

    def test_out_of_range_and_boolean_coordinates_never_send_input(self):
        for coordinate in (800, -1, True, 1.5):
            self.failure("out_of_bounds", {"type": "move", "x": coordinate, "y": 0})
        self.assertEqual(self.events, [])

    def test_cancelled_chord_releases_all_possibly_pressed_keys_in_reverse_order(self):
        def notify(method, signature, arguments, ctx):
            self.events.append((method, arguments))
            if len(self.events) == 2:
                raise Failure("cancelled", "Injected cancellation during second keydown")
        self.portal.notify = notify
        self.failure("cancelled", {"type": "key", "keys": ["ctrl", "shift"]})
        self.assertEqual([call[4][1][2:] for call in self.portal.bus.calls], [(0xffe1, 0), (0xffe3, 0)])
        self.assertEqual(self.portal.held_keys, [])

    def test_release_failure_closes_the_entire_grant(self):
        self.portal.bus = FakeBus(fail=True)
        def notify(*_):
            raise Failure("portal_unavailable", "Injected failure after key may have applied")
        self.portal.notify = notify
        self.failure("input_cleanup_failed", {"type": "key", "keys": ["ctrl"]})
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
