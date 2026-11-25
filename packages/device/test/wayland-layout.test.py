"""Legacy layout fencing contracts; real GNOME acceptance is a separate CI job."""
import copy
import json
import os
from pathlib import Path
import threading
import types
import unittest
from unittest.mock import patch


SOURCE = (Path(__file__).parents[1] / "src/computer/wayland-layout-helper.ts").read_text()
HELPER = SOURCE.split("String.raw`", 1)[1].rsplit("`;", 1)[0]


class Failure(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message


class Context:
    def check(self):
        pass

    def remaining(self, maximum):
        return maximum


class Variant:
    def __init__(self, signature, value):
        self.signature, self.value = signature, value

    def unpack(self):
        return copy.deepcopy(self.value)


SPEC = ("test-output", "test-vendor", "test-product", "private-serial")
STATE = [7, [(SPEC, [("mode", 1600, 1200, 60.0, 1.0, [1.0, 2.0], {"is-current": True})], {})],
         [(0, 0, 1.0, 0, True, [SPEC], {})], {"layout-mode": 1}]
STREAM = {"position": (0, 0), "logical": (1600, 1200),
          "display": {"width": 1600, "height": 1200}}


class Bus:
    def __init__(self):
        self.state = copy.deepcopy(STATE)
        self.owner = ":1.77"
        self.callbacks = {}
        self.counter = 0
        self.calls = []

    def call_sync(self, destination, path, interface, method, parameters, reply, flags, timeout, cancel):
        self.calls.append(method)
        if method == "GetNameOwner":
            if not self.owner:
                raise RuntimeError("service disappeared")
            return Variant("(s)", (self.owner,))
        if method == "GetCurrentState":
            if destination != self.owner:
                raise RuntimeError("original owner disappeared")
            return Variant("state", self.state)
        raise AssertionError("Guard must not mutate compositor state")

    def signal_subscribe(self, sender, interface, signal, path, arg0, flags, callback):
        self.counter += 1
        self.callbacks[self.counter] = (signal, callback)
        return self.counter

    def signal_unsubscribe(self, subscription):
        del self.callbacks[subscription]

    def emit(self, signal, value=()):
        for name, callback in list(self.callbacks.values()):
            if name == signal:
                callback(self, None, None, None, signal, Variant("signal", value))


MODULE = {"__name__": "wayland_layout_test", "json": json, "os": os, "threading": threading,
          "Failure": Failure, "integer": lambda value, low, high: type(value) is int and low <= value <= high,
          "GLib": types.SimpleNamespace(Variant=Variant, VariantType=types.SimpleNamespace(new=lambda signature: signature)),
          "Gio": types.SimpleNamespace(DBusCallFlags=types.SimpleNamespace(NO_AUTO_START=1),
                                       DBusSignalFlags=types.SimpleNamespace(NONE=0))}
exec(compile(HELPER, "embedded-wayland-layout.py", "exec"), MODULE)
LegacyLayout = MODULE["LegacyLayout"]


class LegacyLayoutTests(unittest.TestCase):
    def setUp(self):
        self.bus = Bus()
        self.portal = types.SimpleNamespace(bus=self.bus, streams=[copy.deepcopy(STREAM)])
        self.environment = patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": "ubuntu:GNOME"})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def guard(self, bind=True):
        guard = LegacyLayout(self.portal, Context())
        self.addCleanup(guard.close)
        if bind:
            guard.bind(Context())
        return guard

    def denied(self, guard, expected):
        with self.assertRaises(Failure) as caught:
            guard.check(Context())
        self.assertEqual(caught.exception.code, expected)
        self.assertFalse(guard.available)

    def test_unchanged_native_scale_one_is_allowed_and_every_check_reads_current_state(self):
        guard = self.guard()
        self.assertTrue(guard.available)
        previous = len(self.bus.calls)
        guard.check(Context())
        self.assertEqual(self.bus.calls[previous:], ["GetNameOwner", "GetCurrentState"])

    def test_same_physical_mode_changed_scale_without_signal_or_serial_is_fenced(self):
        guard = self.guard()
        self.bus.state[2][0] = (0, 0, 2.0, 0, True, [SPEC], {})
        self.denied(guard, "display_changed")
        self.bus.state = copy.deepcopy(STATE)
        self.denied(guard, "display_changed")

    def test_streams_are_not_enabled_before_post_consent_binding(self):
        guard = self.guard(bind=False)
        self.assertFalse(guard.available)
        guard.bind(Context())
        self.assertTrue(guard.available)

    def test_equal_size_monitor_swap_during_consent_cannot_rebind_stale_stream(self):
        guard = self.guard(bind=False)
        second = ("test-output-B", "vendor-B", "product-B", "private-serial-B")
        self.bus.state[1].append((second, copy.deepcopy(self.bus.state[1][0][1]), {}))
        self.bus.state[2] = [(1600, 0, 2.0, 0, False, [SPEC], {}),
                             (0, 0, 1.0, 0, True, [second], {})]
        # No signal or serial increment is needed for the baseline comparison
        # to catch this swap. Capture pixel size and old stream position remain
        # identical, and would incorrectly match monitor B in a late snapshot.
        guard.bind(Context())
        self.denied(guard, "display_changed")

    def test_signal_fences_even_when_layout_returns_to_identical_state(self):
        guard = self.guard()
        self.bus.emit("MonitorsChanged")
        self.denied(guard, "display_changed")

    def test_serial_only_change_fences(self):
        guard = self.guard()
        self.bus.state[0] += 1
        self.denied(guard, "display_changed")

    def test_service_replacement_is_fenced_before_new_layout_is_accepted(self):
        guard = self.guard()
        self.bus.owner = ":1.88"
        self.denied(guard, "display_changed")

    def test_service_owner_loss_signal_fences_immediately(self):
        guard = self.guard()
        self.bus.emit("NameOwnerChanged", (LegacyLayout.NAME, self.bus.owner, ""))
        self.denied(guard, "display_changed")

    def test_initial_scaled_or_rotated_monitor_is_capture_only(self):
        for scale, transform in ((2.0, 0), (1.0, 1), (1.25, 0)):
            self.bus.state[2][0] = (0, 0, scale, transform, True, [SPEC], {})
            self.denied(self.guard(), "input_unavailable")

    def test_missing_position_and_ambiguous_monitor_are_refused(self):
        self.portal.streams[0].pop("position")
        self.denied(self.guard(), "input_unavailable")
        self.portal.streams = [copy.deepcopy(STREAM)]
        self.bus.state[2].append(copy.deepcopy(self.bus.state[2][0]))
        self.denied(self.guard(), "input_unavailable")

    def test_same_size_different_origin_is_refused(self):
        self.portal.streams[0]["position"] = (1600, 0)
        self.denied(self.guard(), "input_unavailable")

    def test_capture_dimensions_must_match_the_unscaled_monitor(self):
        self.portal.streams[0]["display"]["width"] = 800
        self.denied(self.guard(), "input_unavailable")

    def test_unknown_desktop_never_probes_or_enables_legacy_input(self):
        with patch.dict(os.environ, {"XDG_CURRENT_DESKTOP": "Other"}):
            self.denied(self.guard(), "input_unavailable")
        self.assertEqual(self.bus.calls, [])

    def test_close_removes_all_signal_subscriptions(self):
        guard = self.guard()
        self.assertEqual(len(self.bus.callbacks), 2)
        guard.close()
        self.assertEqual(self.bus.callbacks, {})
        self.denied(guard, "input_unavailable")

    def test_private_monitor_identifier_never_enters_public_reason(self):
        guard = self.guard()
        self.assertNotIn("private-serial", guard.reason)
        self.bus.emit("MonitorsChanged")
        self.assertNotIn("private-serial", guard.reason)


if __name__ == "__main__":
    unittest.main()
