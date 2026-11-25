"""Real libxkbcommon planning plus deterministic EIS lifetime/coordinate contracts."""
import ctypes
from pathlib import Path
import runpy
import tempfile
import types
import unittest
from unittest.mock import patch

MODULE = runpy.run_path(str(Path(__file__).with_name("wayland-helper.test.py")), run_name="wayland_contract_import")["MODULE"]
Failure, Context, EisInput, XkbKeyboard = (MODULE[name] for name in ("Failure", "Context", "EisInput", "XkbKeyboard"))


class KeymapDescriptor:
    """Only the libei-owned keymap descriptor is substituted; XKB itself is real."""
    def __init__(self):
        self.fd, self.size, self.functions = -1, 0, {}

    def __getattr__(self, name):
        if name not in self.functions:
            self.functions[name] = ((lambda *_: 1) if name == "ei_keymap_get_type"
                else (lambda *_: self.fd) if name == "ei_keymap_get_fd"
                else (lambda *_: self.size) if name == "ei_keymap_get_size"
                else (lambda *_: None))
        return self.functions[name]


class RuleNames(ctypes.Structure):
    _fields_ = [(name, ctypes.c_char_p) for name in ("rules", "model", "layout", "variant", "options")]


class XkbPlanningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        original = ctypes.CDLL
        try:
            original("libxkbcommon.so.0")
        except OSError:
            raise unittest.SkipTest("libxkbcommon0 is needed for real XKB contract tests")
        cls.descriptor = KeymapDescriptor()
        with patch.object(ctypes, "CDLL", side_effect=lambda name: cls.descriptor if name == "libei.so.1" else original(name)):
            cls.api = MODULE["EisApi"]()
        cls.api.xkb.xkb_keymap_new_from_names.argtypes = [ctypes.c_void_p, ctypes.POINTER(RuleNames), ctypes.c_int]
        cls.api.xkb.xkb_keymap_new_from_names.restype = ctypes.c_void_p
        cls.api.xkb.xkb_keymap_get_as_string.argtypes = [ctypes.c_void_p, ctypes.c_int]
        cls.api.xkb.xkb_keymap_get_as_string.restype = ctypes.c_void_p
        cls.libc = original("libc.so.6")
        cls.libc.free.argtypes, cls.libc.free.restype = [ctypes.c_void_p], None

    def keyboard(self, layout="us", with_snapshot=True):
        context = self.api.xkb.xkb_context_new(0)
        keymap = self.api.xkb.xkb_keymap_new_from_names(context,
            ctypes.byref(RuleNames(None, None, layout.encode(), None, b"")), 0)
        if not keymap:
            self.api.xkb.xkb_context_unref(context)
            self.fail("Install xkb-data for the actual " + layout + " keyboard map")
        pointer = self.api.xkb.xkb_keymap_get_as_string(keymap, 1)
        data = ctypes.string_at(pointer) + b"\0"
        self.libc.free(pointer)
        self.api.xkb.xkb_keymap_unref(keymap)
        self.api.xkb.xkb_context_unref(context)
        file = tempfile.TemporaryFile()
        self.addCleanup(file.close)
        file.write(data)
        file.flush()
        self.descriptor.fd, self.descriptor.size = file.fileno(), len(data)
        keyboard = XkbKeyboard(self.api, 1)
        if with_snapshot:
            keyboard.modifiers((0, 0, 0, 0))
        self.addCleanup(keyboard.close)
        return keyboard

    def render_plan(self, keyboard, text):
        plan, baseline = keyboard.plan([ord(character) for character in text], text=True)
        actual = []
        for modifiers, code in plan:
            for modifier in modifiers:
                keyboard.own_key(modifier, True)
            actual.append(chr(self.api.xkb.xkb_state_key_get_one_sym(keyboard.state, code + 8)))
            keyboard.own_key(code, True)
            keyboard.own_key(code, False)
            for modifier in reversed(modifiers):
                keyboard.own_key(modifier, False)
        self.assertEqual("".join(actual), text)
        self.assertEqual(keyboard.mask(), baseline)
        return [code for _, code in plan]

    def test_real_us_german_and_french_maps_produce_requested_text(self):
        plans = {}
        for layout in ("us", "de", "fr"):
            with self.subTest(layout=layout):
                plans[layout] = self.render_plan(self.keyboard(layout), "Abc Yz !09")
        self.assertNotEqual(plans["us"], plans["de"])
        self.assertNotEqual(plans["us"], plans["fr"])

    def test_known_caps_lock_state_is_respected_without_toggling_it(self):
        keyboard = self.keyboard()
        plan, _ = keyboard.plan([MODULE["keysym"]("capslock")])
        code = plan[0][1]
        keyboard.own_key(code, True)
        keyboard.own_key(code, False)
        self.assertTrue(keyboard.mask()[2])
        self.render_plan(keyboard, "Aa!")
        self.assertTrue(keyboard.mask()[2])

    def test_known_active_modifiers_reject_text_and_chords(self):
        keyboard = self.keyboard()
        shift = keyboard.plan([MODULE["keysym"]("shift")])[0][0][1]
        keyboard.own_key(shift, True)
        for text in (False, True):
            with self.assertRaises(Failure) as caught:
                keyboard.plan([ord("a")], text=text)
            self.assertEqual(caught.exception.code, "keyboard_modifiers_active")

    def test_pause_neutralizes_owned_shift_before_resume(self):
        keyboard = self.keyboard()
        shift = keyboard.plan([MODULE["keysym"]("shift")])[0][0][1]
        keyboard.own_key(shift, True)
        self.assertTrue(keyboard.mask()[0])
        keyboard.neutralize()
        self.assertEqual(keyboard.mask()[0], 0)
        self.assertFalse(keyboard.modifiers_known)
        keyboard.modifiers((0, 0, 0, 0))
        self.render_plan(keyboard, "Aa!")

    def test_unknown_initial_modifiers_disable_keyboard_before_any_event(self):
        keyboard = self.keyboard(with_snapshot=False)
        instance = EisContracts.bare(self)
        selected = EisContracts.record(self, 9)
        record = EisContracts.record(self, 10, caps=(4,))
        record["keyboard"] = keyboard
        instance.devices = {9: selected, 10: record}
        instance.region = lambda _: (selected, (0, 0, 800, 600))
        instance.sync = lambda ctx: ctx.check()
        streams = [{"mapping": "selected", "epoch": "session", "serial": 7, "node": 23,
                    "display": {"id": "wayland:23", "width": 800, "height": 600, "rotation": 0}}]
        self.assertEqual(instance.actions(streams), ["move", "click", "drag", "scroll"])
        with self.assertRaises(Failure) as caught:
            keyboard.plan([ord("A")], text=True)
        self.assertEqual(caught.exception.code, "keyboard_state_unavailable")
        instance.display(streams[0])
        with self.assertRaises(Failure) as caught:
            instance.act({"type": "text", "text": "Aa!"}, streams[0], dict(streams[0]["display"]),
                         [65, 97, 33], Context(2000))
        self.assertEqual(caught.exception.code, "input_unavailable")
        self.assertEqual(instance.held, [])
        keyboard.modifiers((0, 0, 0, 0))
        self.assertEqual(instance.actions(streams), ["move", "click", "drag", "scroll", "key", "text"])

    def test_pause_then_resume_cannot_continue_a_shifted_character(self):
        keyboard = self.keyboard()
        instance = EisContracts.bare(self)
        record = EisContracts.record(self, 10, caps=(4,))
        record["keyboard"] = keyboard
        instance.devices = {10: record}
        shift = keyboard.plan([MODULE["keysym"]("shift")])[0][0][1]
        keyboard.own_key(shift, True)
        instance.held = [("key", 10, shift)]
        events = iter((7, 8, None))
        instance.api = types.SimpleNamespace(ei=types.SimpleNamespace(
            ei_dispatch=lambda _: None, ei_get_event=lambda _: next(events, None),
            ei_event_get_type=lambda event: event, ei_event_get_device=lambda _: 10,
            ei_event_unref=lambda _: None, ei_device_start_emulating=lambda *_: None,
            ei_device_keyboard_key=lambda *_: self.fail("A neutralized Shift must not be followed by the character")))
        instance.pump = lambda wait=0: EisInput.pump(instance, wait)
        with self.assertRaises(Failure) as caught:
            instance.key(record, 30, True, Context(2000), 5)
        self.assertEqual(caught.exception.code, "input_interrupted")
        self.assertTrue(record["active"])
        self.assertEqual(keyboard.mask()[0], 0)
        self.assertEqual(instance.held, [])

    def test_replacement_map_replans_remaining_text_without_replaying_characters(self):
        old_map, new_map = self.keyboard("us"), self.keyboard("de")
        instance = EisContracts.bare(self)
        selected = EisContracts.record(self, 9)
        old_record = EisContracts.record(self, 10, caps=(4,))
        new_record = EisContracts.record(self, 11, caps=(4,))
        old_record["keyboard"], new_record["keyboard"] = old_map, new_map
        instance.devices = {9: selected, 10: old_record}
        instance.region = lambda mapping: (selected, (0, 0, 800, 600))
        sync_count = 0
        def sync(ctx):
            nonlocal sync_count
            ctx.check()
            sync_count += 1
            if sync_count == 3:  # First character was fully released.
                self.assertEqual(instance.held, [])
                old_record["active"] = False
                instance.changed(6, old_record)
                old_map.close()
                del instance.devices[10]
                instance.devices[11] = new_record
                instance.changed(5, new_record)
                instance.changed(8, new_record)
        instance.sync = sync
        actual = []
        def send(pointer, code, pressed):
            if pressed:
                keyboard = instance.devices[pointer]["keyboard"]
                symbol = keyboard.api.xkb.xkb_state_key_get_one_sym(keyboard.state, code + 8)
                if 32 <= symbol <= 126:
                    actual.append(chr(symbol))
        instance.api = types.SimpleNamespace(ei=types.SimpleNamespace(
            ei_device_keyboard_key=send, ei_device_frame=lambda *_: None,
            ei_now=lambda _: 2000000, ei_dispatch=lambda _: None))
        stream = {"mapping": "selected", "epoch": "session", "serial": 7, "node": 23,
                  "display": {"id": "wayland:23", "width": 800, "height": 600, "rotation": 0}}
        instance.display(stream)
        text = "AYz!"
        instance.act({"type": "text", "text": text}, stream, dict(stream["display"]),
                     [ord(character) for character in text], Context(2000))
        self.assertEqual("".join(actual), text)
        self.assertEqual(instance.generation, 5)
        self.assertEqual(instance.held, [])


class EisContracts(unittest.TestCase):
    def bare(self):
        instance = EisInput.__new__(EisInput)
        instance.context, instance.connected, instance.generation = 1, True, 5
        instance.devices, instance.held, instance.device_changes = {}, [], []
        instance.input_interrupted, instance.sequence = False, 0
        instance.session_check = None
        instance.expected_ping, instance.pong_received = None, False
        instance.pump = lambda *_: None
        return instance

    def record(self, pointer, seat=1, virtual=True, caps=(2, 16, 32)):
        return {"pointer": pointer, "seat": seat, "virtual": virtual, "active": True,
                "caps": set(caps), "keyboard": None}

    def test_buttons_prefer_the_selected_monitor_and_never_a_physical_device(self):
        instance = self.bare()
        first, second, physical = self.record(1), self.record(2), self.record(3, virtual=False)
        instance.devices = {1: first, 2: second, 3: physical}
        self.assertIs(instance.device(32, 1, second), second)
        self.assertIs(instance.device(16, 1, first), first)
        instance.devices = {3: physical}
        self.assertIsNone(instance.device(32, 1))

    def test_missing_keyboard_map_does_not_hide_working_pointer_actions(self):
        instance = self.bare()
        selected = self.record(9)
        keyboard = self.record(10, caps=(4,))
        instance.devices = {9: selected, 10: keyboard}
        instance.region = lambda mapping: (selected, (0, 0, 800, 600))
        streams = [{"mapping": "selected"}]
        self.assertTrue(instance.ready(streams))
        self.assertEqual(instance.actions(streams), ["move", "click", "drag", "scroll"])

    def test_connected_unmapped_eis_stops_waiting_after_ten_seconds(self):
        instance = self.bare()
        instance.api = types.SimpleNamespace(ei=types.SimpleNamespace(
            ei_new_sender=lambda _: 1, ei_configure_name=lambda *_: None,
            ei_setup_backend_fd=lambda *_: 0))
        instance.ready = lambda _: False
        context = types.SimpleNamespace(check=lambda: None)
        with patch.object(MODULE["os"], "set_blocking"), patch.object(MODULE["time"], "monotonic", side_effect=(0, 9.99, 10)):
            self.assertFalse(instance.connect(33, [{"mapping": "missing"}], context))
        self.assertTrue(instance.connected)

    def test_missing_xkb_library_is_an_optional_keyboard_dependency(self):
        descriptor = KeymapDescriptor()
        def library(name):
            if name == "libei.so.1":
                return descriptor
            raise OSError("fixture library unavailable")
        with patch.object(ctypes, "CDLL", side_effect=library):
            api = MODULE["EisApi"]()
        self.assertIsNone(api.xkb)
        with self.assertRaises(Failure) as caught:
            XkbKeyboard(api, 1)
        self.assertEqual(caught.exception.code, "eis_keymap_unsupported")

    def test_keyboard_replacement_does_not_relabel_the_captured_monitor(self):
        instance = self.bare()
        keyboard, monitor = self.record(10, caps=(4,)), self.record(9)
        for kind in (6, 5, 8):
            instance.changed(kind, keyboard)
        self.assertEqual(instance.generation, 5)
        instance.changed(7, monitor)
        self.assertEqual(instance.generation, 6)

    def test_reused_c_pointer_never_reuses_an_old_keyboard_map(self):
        instance = self.bare()
        stale = self.record(10, caps=(4,))
        stale["keyboard"] = object()
        instance.devices[10] = self.record(10, caps=(4,))
        with self.assertRaises(Failure) as caught:
            instance.key(stale, 30, True, Context(2000), 5)
        self.assertEqual(caught.exception.code, "keyboard_changed")
        self.assertTrue(caught.exception.details["mayHaveApplied"])
        self.assertEqual(instance.held, [])

    def test_live_region_offsets_and_extent_override_portal_start_size(self):
        instance = self.bare()
        selected = self.record(9)
        instance.devices = {9: selected}
        instance.region = lambda mapping: (selected, (900, 200, 800, 600))
        instance.sync = lambda ctx: ctx.check()
        movements, frames = [], []
        instance.api = types.SimpleNamespace(ei=types.SimpleNamespace(
            ei_device_pointer_motion_absolute=lambda pointer, x, y: movements.append((pointer, x, y)),
            ei_device_frame=lambda pointer, timestamp: frames.append((pointer, timestamp)),
            ei_now=lambda context: 2000000, ei_dispatch=lambda context: None))
        stream = {"mapping": "selected", "epoch": "session", "serial": 7, "node": 23, "logical": (999, 999),
                  "display": {"id": "wayland:23", "width": 1600, "height": 1200, "rotation": 0}}
        instance.display(stream)
        display = dict(stream["display"])
        instance.act({"type": "move", "x": 600, "y": 400}, stream, display, None, Context(2000))
        self.assertEqual(movements, [(9, 1200.0, 400.0)])
        self.assertEqual(len(frames), 1)
        self.assertEqual((display["scaleX"], display["scaleY"]), (2, 2))

    def test_portal_revocation_is_checked_before_input_processing(self):
        instance = self.bare()
        def revoked(_ctx):
            raise Failure("portal_session_required", "Session revoked")
        instance.session_check = revoked
        instance.pump = lambda *_: self.fail("Revoked session must not continue input processing")
        with self.assertRaises(Failure) as caught:
            instance.check(Context(2000), 5)
        self.assertEqual(caught.exception.code, "portal_session_required")

    def test_fake_pong_on_disconnect_does_not_validate_a_round_trip(self):
        instance = self.bare()
        released = []
        instance.api = types.SimpleNamespace(ei=types.SimpleNamespace(
            ei_new_ping=lambda context: 42, ei_ping=lambda ping: None, ei_ping_unref=lambda ping: released.append(ping)))
        def pump(_wait=0):
            if instance.expected_ping == 42:
                instance.pong_received = True
                instance.connected = False
        instance.pump = pump
        with self.assertRaises(Failure) as caught:
            instance.sync(Context(2000))
        self.assertEqual(caught.exception.code, "eis_disconnected")
        self.assertEqual(released, [42])
        self.assertIsNone(instance.expected_ping)


if __name__ == "__main__":
    unittest.main()
