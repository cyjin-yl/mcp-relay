/** Optional libei input transport. Loaded by the same owned Wayland helper. */
export const waylandEisHelper = String.raw`
import ctypes
import select


class EisApi:
    def __init__(self):
        self.ei = ctypes.CDLL("libei.so.1")
        self.xkb = ctypes.CDLL("libxkbcommon.so.0")
        p, u, i, b, d, z = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_bool, ctypes.c_double, ctypes.c_size_t
        functions = {
            "ei_new_sender": (p, [p]), "ei_unref": (p, [p]), "ei_configure_name": (None, [p, ctypes.c_char_p]),
            "ei_setup_backend_fd": (i, [p, i]), "ei_get_fd": (i, [p]), "ei_dispatch": (None, [p]),
            "ei_get_event": (p, [p]), "ei_event_get_type": (i, [p]), "ei_event_unref": (p, [p]),
            "ei_event_get_seat": (p, [p]), "ei_event_get_device": (p, [p]),
            "ei_seat_has_capability": (b, [p, i]), "ei_seat_bind_capabilities": (None, [p]),
            "ei_device_ref": (p, [p]), "ei_device_unref": (p, [p]), "ei_device_has_capability": (b, [p, i]),
            "ei_device_get_seat": (p, [p]), "ei_device_get_type": (i, [p]),
            "ei_device_get_region": (p, [p, z]), "ei_region_get_mapping_id": (ctypes.c_char_p, [p]),
            "ei_region_get_x": (u, [p]), "ei_region_get_y": (u, [p]),
            "ei_region_get_width": (u, [p]), "ei_region_get_height": (u, [p]),
            "ei_region_get_physical_scale": (d, [p]),
            "ei_device_start_emulating": (None, [p, u]), "ei_device_stop_emulating": (None, [p]),
            "ei_device_frame": (None, [p, ctypes.c_uint64]), "ei_now": (ctypes.c_uint64, [p]),
            "ei_device_pointer_motion_absolute": (None, [p, d, d]),
            "ei_device_button_button": (None, [p, u, b]), "ei_device_scroll_discrete": (None, [p, ctypes.c_int32, ctypes.c_int32]),
            "ei_device_keyboard_key": (None, [p, u, b]), "ei_device_keyboard_get_keymap": (p, [p]),
            "ei_keymap_get_type": (i, [p]), "ei_keymap_get_fd": (i, [p]), "ei_keymap_get_size": (z, [p]),
            "ei_event_keyboard_get_xkb_mods_depressed": (u, [p]), "ei_event_keyboard_get_xkb_mods_latched": (u, [p]),
            "ei_event_keyboard_get_xkb_mods_locked": (u, [p]), "ei_event_keyboard_get_xkb_group": (u, [p]),
            "ei_new_ping": (p, [p]), "ei_ping": (None, [p]), "ei_ping_unref": (p, [p]),
            "ei_event_pong_get_ping": (p, [p]),
        }
        for name, (result, arguments) in functions.items():
            function = getattr(self.ei, name)
            function.restype, function.argtypes = result, arguments
        xkb_functions = {
            "xkb_context_new": (p, [i]), "xkb_context_unref": (None, [p]),
            "xkb_keymap_new_from_buffer": (p, [p, ctypes.c_char_p, z, i, i]), "xkb_keymap_unref": (None, [p]),
            "xkb_keymap_min_keycode": (u, [p]), "xkb_keymap_max_keycode": (u, [p]),
            "xkb_state_new": (p, [p]), "xkb_state_unref": (None, [p]),
            "xkb_state_update_mask": (u, [p, u, u, u, u, u, u]), "xkb_state_update_key": (u, [p, u, i]),
            "xkb_state_serialize_mods": (u, [p, u]), "xkb_state_serialize_layout": (u, [p, u]),
            "xkb_state_key_get_one_sym": (u, [p, u]),
        }
        for name, (result, arguments) in xkb_functions.items():
            function = getattr(self.xkb, name)
            function.restype, function.argtypes = result, arguments


class XkbKeyboard:
    def __init__(self, api, keymap):
        self.api, self.context, self.keymap, self.state = api, None, None, None
        try:
            size = int(api.ei.ei_keymap_get_size(keymap))
            fd = api.ei.ei_keymap_get_fd(keymap)
            if api.ei.ei_keymap_get_type(keymap) != 1 or fd < 0 or not 1 <= size <= 2 * 1024 * 1024:
                raise Failure("eis_keymap_unsupported", "The compositor did not provide a bounded XKB keyboard map.")
            # The keymap fd is borrowed from libei. pread neither closes it nor
            # changes its position; the compositor-provided map is the only map.
            data = os.pread(fd, size, 0)
            if len(data) != size:
                raise Failure("eis_keymap_unsupported", "The compositor keyboard map is incomplete.")
            data = data.rstrip(b"\0")
            self.context = api.xkb.xkb_context_new(0)
            if not self.context:
                raise Failure("eis_keymap_unsupported", "The XKB context could not be created.")
            self.keymap = api.xkb.xkb_keymap_new_from_buffer(self.context, data, len(data), 1, 0)
            if not self.keymap:
                raise Failure("eis_keymap_unsupported", "The compositor keyboard map could not be parsed.")
            self.first = max(8, api.xkb.xkb_keymap_min_keycode(self.keymap))
            self.last = min(775, api.xkb.xkb_keymap_max_keycode(self.keymap))
            self.state = api.xkb.xkb_state_new(self.keymap)
            if not self.state or self.last < self.first:
                raise Failure("eis_keymap_unsupported", "The compositor keyboard has no usable evdev keys.")
        except Exception:
            self.close()
            raise

    def close(self):
        for name, release in (("state", self.api.xkb.xkb_state_unref),
                              ("keymap", self.api.xkb.xkb_keymap_unref), ("context", self.api.xkb.xkb_context_unref)):
            value = getattr(self, name, None)
            if value:
                release(value)
                setattr(self, name, None)

    def modifiers(self, values):
        depressed, latched, locked, group = values
        self.api.xkb.xkb_state_update_mask(self.state, depressed, latched, locked, 0, 0, group)

    def own_key(self, code, pressed):
        # Some compositor EIS versions supply a keymap but no modifier events.
        # Retain ordered state for our own virtual keys, and replace masks when
        # the server supplies them. This does not exclude concurrent local input.
        self.api.xkb.xkb_state_update_key(self.state, code + 8, 1 if pressed else 0)

    def neutralize(self):
        _depressed, _latched, locked, group = self.mask()
        previous = self.state
        self.state = self.api.xkb.xkb_state_new(self.keymap)
        if not self.state:
            self.state = previous
            raise Failure("eis_keymap_unsupported", "The paused keyboard state could not be reset.")
        self.api.xkb.xkb_state_update_mask(self.state, 0, 0, locked, 0, 0, group)
        self.api.xkb.xkb_state_unref(previous)

    def mask(self):
        xkb = self.api.xkb
        return tuple(xkb.xkb_state_serialize_mods(self.state, flag) for flag in (1, 2, 4)) + (
            xkb.xkb_state_serialize_layout(self.state, 128),)

    def scratch(self, modifiers=None):
        result = self.api.xkb.xkb_state_new(self.keymap)
        if not result:
            raise Failure("eis_keymap_unsupported", "The keyboard planning state could not be created.")
        depressed, latched, locked, group = self.mask() if modifiers is None else modifiers
        self.api.xkb.xkb_state_update_mask(result, depressed, latched, locked, 0, 0, group)
        return result

    def find(self, state, symbol):
        for code in range(self.first, self.last + 1):
            if self.api.xkb.xkb_state_key_get_one_sym(state, code) == symbol:
                return code - 8
        return None

    def plan(self, symbols, text=False):
        mask = self.mask()
        if mask[0] or mask[1]:
            raise Failure("keyboard_modifiers_active", "Release active keyboard modifiers before sending keyboard input.")
        base = self.scratch(mask if text else (0, 0, 0, mask[3]))
        shifted = self.scratch(mask if text else (0, 0, 0, mask[3]))
        neutral = self.scratch((0, 0, 0, mask[3]))
        try:
            shift = self.find(neutral, 0xffe1)
            if shift is not None:
                self.api.xkb.xkb_state_update_key(shifted, shift + 8, 1)
            plan = []
            for symbol in symbols:
                code = self.find(base, symbol)
                extra = []
                if code is None and shift is not None:
                    code = self.find(shifted, symbol)
                    extra = [shift]
                if code is None:
                    raise Failure("keymap_character_unsupported", "The active compositor keyboard map cannot produce a requested character with an unmodified or Shift key.")
                plan.append((extra, code))
            return plan, mask
        finally:
            for state in (base, shifted, neutral):
                self.api.xkb.xkb_state_unref(state)


class EisInput:
    CAPS = (2, 4, 16, 32)  # absolute pointer, keyboard, scroll, button

    def __init__(self):
        # All symbols are verified before ConnectToEIS. A connected session must
        # never return to Notify methods, including when a later operation fails.
        self.api = EisApi()
        self.context = None
        self.connected = False
        self.devices = {}
        self.generation = 0
        self.device_changes = []
        self.sequence = 0
        self.held = []
        self.expected_ping = None
        self.pong_received = False
        self.session_check = None

    def connect(self, fd, streams, ctx):
        transferred = False
        try:
            os.set_blocking(fd, False)
            self.context = self.api.ei.ei_new_sender(None)
            if not self.context:
                raise Failure("eis_unavailable", "The libei sender could not be created.")
            self.api.ei.ei_configure_name(self.context, b"mcp-relay")
            # ei_setup_backend_fd owns this fd, including cleanup after failure.
            transferred = True
            if self.api.ei.ei_setup_backend_fd(self.context, fd) != 0:
                raise Failure("eis_unavailable", "The desktop EIS connection could not start.")
            while True:
                self.check_session(ctx)
                self.pump(0.025)
                if self.connected and self.ready(streams):
                    self.sync(ctx)
                    if self.ready(streams):
                        return
        finally:
            if not transferred:
                os.close(fd)

    def frame(self, device):
        self.api.ei.ei_device_frame(device, self.api.ei.ei_now(self.context))

    def check_session(self, ctx):
        ctx.check()
        if self.session_check is not None:
            self.session_check(ctx)

    def changed(self, kind, record):
        self.generation += 1
        self.device_changes.append({"generation": self.generation,
            "event": {5: "added", 6: "removed", 7: "paused", 8: "resumed"}[kind],
            "capabilities": sorted(record["caps"]), "virtual": record["virtual"]})
        self.device_changes = self.device_changes[-16:]

    def pump(self, wait=0):
        if not self.context:
            return
        api = self.api.ei
        api.ei_dispatch(self.context)
        received = False
        for _ in range(4096):
            event = api.ei_get_event(self.context)
            if not event:
                break
            received = True
            try:
                kind = api.ei_event_get_type(event)
                if kind == 1:
                    self.connected = True
                elif kind == 2:
                    self.connected = False
                    raise Failure("eis_disconnected", "The compositor closed the EIS input connection.")
                elif kind == 3:
                    seat = api.ei_event_get_seat(event)
                    caps = [ctypes.c_int(cap) for cap in self.CAPS if api.ei_seat_has_capability(seat, cap)]
                    if caps:
                        api.ei_seat_bind_capabilities(seat, *caps, ctypes.c_void_p())
                elif kind in (5, 6, 7, 8, 9):
                    pointer = api.ei_event_get_device(event)
                    if kind == 5:
                        if not pointer or pointer in self.devices or len(self.devices) >= 32:
                            raise Failure("eis_protocol", "The compositor supplied invalid or excessive EIS devices.")
                        device = api.ei_device_ref(pointer)
                        record = {"pointer": device, "seat": api.ei_device_get_seat(device),
                            "virtual": api.ei_device_get_type(device) == 1, "active": False, "caps": {
                            cap for cap in self.CAPS if api.ei_device_has_capability(device, cap)}, "keyboard": None}
                        self.devices[pointer] = record
                        if record["virtual"] and 4 in record["caps"]:
                            keymap = api.ei_device_keyboard_get_keymap(device)
                            if keymap:
                                record["keyboard"] = XkbKeyboard(self.api, keymap)
                        self.changed(kind, record)
                    elif kind == 9:
                        record = self.devices.get(pointer)
                        if record and record["keyboard"]:
                            record["keyboard"].modifiers((api.ei_event_keyboard_get_xkb_mods_depressed(event),
                                api.ei_event_keyboard_get_xkb_mods_latched(event), api.ei_event_keyboard_get_xkb_mods_locked(event),
                                api.ei_event_keyboard_get_xkb_group(event)))
                    else:
                        record = self.devices.get(pointer)
                        if not record:
                            continue
                        self.changed(kind, record)
                        if kind in (6, 7):
                            # EI pause/removal neutralizes the server device.
                            # Never send an up event through a dead device pointer.
                            record["active"] = False
                            self.held = [held for held in self.held if held[1] != pointer]
                            if kind == 7 and record["keyboard"]:
                                record["keyboard"].neutralize()
                        if kind == 6:
                            if record["keyboard"]:
                                record["keyboard"].close()
                            api.ei_device_unref(pointer)
                            del self.devices[pointer]
                        elif kind == 8 and record["virtual"]:
                            self.sequence = (self.sequence + 1) & 0xffffffff
                            api.ei_device_start_emulating(pointer, self.sequence)
                            record["active"] = True
                elif kind == 90:
                    if self.expected_ping is not None and api.ei_event_pong_get_ping(event) == self.expected_ping:
                        self.pong_received = True
            finally:
                api.ei_event_unref(event)
        else:
            raise Failure("eis_protocol", "The EIS event queue exceeded its bounded limit.")
        if wait and not received:
            fd = api.ei_get_fd(self.context)
            if fd < 0:
                raise Failure("eis_disconnected", "The compositor EIS connection is no longer pollable.")
            select.select([fd], [], [], wait)

    def sync(self, ctx):
        self.check_session(ctx)
        self.pump()
        if not self.connected:
            raise Failure("eis_disconnected", "The EIS connection is not ready.")
        api = self.api.ei
        ping = api.ei_new_ping(self.context)
        if not ping:
            raise Failure("eis_unavailable", "The EIS synchronization request could not be created.")
        try:
            self.expected_ping = ping
            self.pong_received = False
            api.ei_ping(ping)
            while not self.pong_received:
                self.check_session(ctx)
                self.pump(0.025)
            # libei also synthesizes a PONG on disconnect. Drain its subsequent
            # disconnect/removal events before treating this round trip as valid.
            self.pump()
            self.check_session(ctx)
            if not self.connected:
                raise Failure("eis_disconnected", "The EIS connection closed during synchronization.")
        finally:
            self.expected_ping = None
            self.pong_received = False
            api.ei_ping_unref(ping)

    def region(self, mapping):
        matches = []
        api = self.api.ei
        for record in self.devices.values():
            if not record["active"] or not record["virtual"] or 2 not in record["caps"]:
                continue
            for index in range(32):
                region = api.ei_device_get_region(record["pointer"], index)
                if not region:
                    break
                identity = api.ei_region_get_mapping_id(region)
                if identity is not None and identity.decode("utf8", "strict") == mapping:
                    dimensions = tuple(int(function(region)) for function in
                        (api.ei_region_get_x, api.ei_region_get_y, api.ei_region_get_width, api.ei_region_get_height))
                    physical_scale = api.ei_region_get_physical_scale(region)
                    if (not 1 <= dimensions[2] <= 32768 or not 1 <= dimensions[3] <= 32768
                            or not math.isfinite(physical_scale) or physical_scale <= 0):
                        raise Failure("eis_geometry", "The compositor supplied an invalid EIS monitor region.")
                    matches.append((record, dimensions))
            else:
                raise Failure("eis_geometry", "The compositor supplied too many EIS regions.")
        if len(matches) > 1:
            raise Failure("eis_geometry", "The selected monitor maps to more than one live EIS region.")
        return matches[0] if matches else None

    def device(self, capability, seat, preferred=None):
        if (preferred is not None and preferred["active"] and preferred["virtual"] and capability in preferred["caps"]
                and (capability != 4 or preferred["keyboard"] is not None)):
            return preferred
        matches = [record for record in self.devices.values() if record["active"] and record["virtual"] and record["seat"] == seat and capability in record["caps"]
                   and (capability != 4 or record["keyboard"] is not None)]
        if len(matches) > 1:
            raise Failure("eis_device_ambiguous", "The compositor supplied multiple independent devices for this input capability.")
        return matches[0] if matches else None

    def ready(self, streams):
        if not self.connected:
            return False
        for stream in streams:
            mapped = self.region(stream["mapping"])
            if mapped is None or any(self.device(capability, mapped[0]["seat"], mapped[0]) is None for capability in (4, 16, 32)):
                return False
        return True

    def display(self, stream):
        mapped = self.region(stream["mapping"])
        if mapped is None:
            raise Failure("display_changed", "The selected monitor has no live EIS region. Capture a new frame after the display settles.")
        _record, (x, y, width, height) = mapped
        result = stream["display"]
        result.update(x=x, y=y, scaleX=result["width"] / width, scaleY=result["height"] / height,
                      instanceId=stream["epoch"] + ":" + str(stream["serial"] or stream["node"]) + ":ei:" + str(self.generation))

    def check(self, ctx, generation, phase="input"):
        self.check_session(ctx)
        self.pump()
        if not self.connected:
            raise Failure("eis_disconnected", "The compositor EIS input connection closed.")
        if generation != self.generation:
            raise Failure("display_changed", "The compositor input devices or monitor regions changed. Capture a new frame.", {
                "phase": phase, "expectedGeneration": generation, "currentGeneration": self.generation,
                "deviceChanges": [change for change in self.device_changes if change["generation"] > generation]})

    def key(self, record, code, pressed, ctx, generation):
        self.check(ctx, generation, "keyboard-event")
        pointer = record["pointer"]
        if pressed:
            self.held.append(("key", pointer, code))
        self.api.ei.ei_device_keyboard_key(pointer, code, pressed)
        self.frame(pointer)  # down/up must never share a frame
        record["keyboard"].own_key(code, pressed)
        if not pressed:
            self.held.remove(("key", pointer, code))
        self.api.ei.ei_dispatch(self.context)

    def release(self):
        if not self.context:
            return True
        try:
            for kind, pointer, code in reversed(self.held):
                record = self.devices.get(pointer)
                if not record or not record["active"]:
                    continue
                if kind == "key":
                    self.api.ei.ei_device_keyboard_key(pointer, code, False)
                    if record["keyboard"]:
                        record["keyboard"].own_key(code, False)
                else:
                    self.api.ei.ei_device_button_button(pointer, code, False)
                self.frame(pointer)
            self.held.clear()
            self.api.ei.ei_dispatch(self.context)
            return True
        except Exception:
            return False

    def act(self, action, stream, display, symbols, ctx):
        self.sync(ctx)
        self.display(stream)
        if stream["display"]["instanceId"] != display["instanceId"]:
            raise Failure("display_changed", "The EIS input generation changed; capture a new frame.")
        generation = self.generation
        kind = action["type"]
        mapped = self.region(stream["mapping"])
        if mapped is None:
            raise Failure("display_changed", "The EIS monitor region disappeared.")
        seat = mapped[0]["seat"]
        selected = mapped[0]
        keyboard = self.device(4, seat, selected)
        plan = None
        if kind in ("key", "text"):
            if keyboard is None:
                raise Failure("input_unavailable", "The EIS keyboard is not active.")
            plan, baseline = keyboard["keyboard"].plan(symbols, text=kind == "text")
        def move(x, y):
            self.check(ctx, generation, "pointer-motion")
            mapped = self.region(stream["mapping"])
            if mapped is None:
                raise Failure("display_changed", "The EIS monitor region disappeared.")
            record, (origin_x, origin_y, width, height) = mapped
            pointer = record["pointer"]
            self.api.ei.ei_device_pointer_motion_absolute(pointer,
                origin_x + x * width / display["width"], origin_y + y * height / display["height"])
            self.frame(pointer)
            self.api.ei.ei_dispatch(self.context)
        def button(code, pressed):
            self.check(ctx, generation, "pointer-button")
            record = self.device(32, seat, selected)
            if record is None:
                raise Failure("input_unavailable", "The EIS pointer buttons are not active.")
            pointer = record["pointer"]
            if pressed:
                self.held.append(("button", pointer, code))
            self.api.ei.ei_device_button_button(pointer, code, pressed)
            self.frame(pointer)
            if not pressed:
                self.held.remove(("button", pointer, code))
            self.api.ei.ei_dispatch(self.context)
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
                self.check(ctx, generation, "scroll")
                record = self.device(16, seat, selected)
                if record is None:
                    raise Failure("input_unavailable", "The EIS scroll device is not active.")
                amount = action.get("amount", 3) * 120
                direction = action["direction"]
                self.api.ei.ei_device_scroll_discrete(record["pointer"],
                    -amount if direction == "left" else amount if direction == "right" else 0,
                    -amount if direction == "up" else amount if direction == "down" else 0)
                self.frame(record["pointer"])
            elif kind == "key":
                codes = []
                for extra, code in plan:
                    for item in (*extra, code):
                        if item not in codes:
                            codes.append(item)
                for code in codes:
                    self.key(keyboard, code, True, ctx, generation)
                for code in reversed(codes):
                    self.key(keyboard, code, False, ctx, generation)
            elif kind == "text":
                # Validate the whole string above, then synchronize each owned
                # modifier transaction. No clipboard and no implicit Enter/Tab.
                for extra, code in plan:
                    self.sync(ctx)
                    self.check(ctx, generation, "text")
                    current = keyboard["keyboard"].mask()
                    if current != baseline:
                        raise Failure("keyboard_state_changed", "Keyboard modifiers or layout changed during text input; remaining text was not sent.", {"mayHaveApplied": True})
                    for modifier in extra:
                        self.key(keyboard, modifier, True, ctx, generation)
                    self.key(keyboard, code, True, ctx, generation)
                    self.key(keyboard, code, False, ctx, generation)
                    for modifier in reversed(extra):
                        self.key(keyboard, modifier, False, ctx, generation)
            self.sync(ctx)
            self.check(ctx, generation, "input-flush")
        finally:
            if not self.release():
                raise Failure("input_cleanup_failed", "EIS input release failed; the portal session must close.")
        return {"submitted": True, "verified": False,
            "verification": "Capture the result to verify application behavior.", "inputBackend": "Wayland EIS / libei"}

    def close(self):
        if not self.context:
            return
        self.release()
        for record in list(self.devices.values()):
            if record["active"]:
                self.api.ei.ei_device_stop_emulating(record["pointer"])
            if record["keyboard"]:
                record["keyboard"].close()
            self.api.ei.ei_device_unref(record["pointer"])
        self.devices.clear()
        self.api.ei.ei_unref(self.context)
        self.context = None
        self.connected = False
`;
