/** Conservative compatibility guard for GNOME portals predating EIS.
 * DisplayConfig is read only; no monitor settings are changed by this helper.
 */
export const waylandLayoutHelper = String.raw`
class LegacyLayout:
    NAME = "org.gnome.Mutter.DisplayConfig"
    PATH = "/org/gnome/Mutter/DisplayConfig"
    REPLY = "(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})"

    def __init__(self, portal, ctx):
        self.portal = portal
        self.available = False
        self.reason = "Reliable monitor mapping requires EIS, or an unchanged GNOME monitor at scale 1 without rotation. Capture remains available."
        self.owner = None
        self.baseline = None
        self.snapshot = None
        self.subscriptions = []
        self.fenced = threading.Event()
        self.closed = False
        desktop = os.environ.get("XDG_CURRENT_DESKTOP", "").upper().split(":")
        if "GNOME" not in desktop:
            return
        try:
            # Construct this guard before CreateSession/Start. A layout change
            # while the user is choosing monitors must not let stale stream
            # geometry accidentally match a different current monitor.
            self.subscriptions.append(portal.bus.signal_subscribe(
                "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
                "/org/freedesktop/DBus", self.NAME, Gio.DBusSignalFlags.NONE, self._owner_changed))
            self.owner = self._owner(ctx)
            self.subscriptions.append(portal.bus.signal_subscribe(
                self.owner, self.NAME, "MonitorsChanged", self.PATH, None,
                Gio.DBusSignalFlags.NONE, self._monitors_changed))
            state = self._state(ctx)
            self.baseline = state
            self.snapshot = self._fingerprint(state)
            # Close the owner/state-read race before starting consent. Input
            # stays disabled until bind validates the subsequently chosen
            # streams against this same unchanged baseline.
            if self._owner(ctx) != self.owner or self._fingerprint(self._state(ctx)) != self.snapshot:
                self._fence()
        except Exception:
            self.available = False
            self.close()
            ctx.check()

    def bind(self, ctx):
        ctx.check()
        if self.closed or self.fenced.is_set() or self.baseline is None:
            return
        try:
            if self._owner(ctx) != self.owner or self._fingerprint(self._state(ctx)) != self.snapshot:
                self._fence()
                return
            self._validate_streams(self.baseline)
            if self._owner(ctx) != self.owner or self._fingerprint(self._state(ctx)) != self.snapshot:
                self._fence()
            if not self.fenced.is_set():
                self.available = True
                self.reason = "GNOME scale-1 monitor mapping is guarded by the live DisplayConfig owner, serial and layout. Reauthorize after any display change."
        except Exception:
            self.available = False
            self.close()
            ctx.check()

    def _owner(self, ctx):
        return self.portal.bus.call_sync("org.freedesktop.DBus", "/org/freedesktop/DBus",
            "org.freedesktop.DBus", "GetNameOwner", GLib.Variant("(s)", (self.NAME,)),
            GLib.VariantType.new("(s)"), Gio.DBusCallFlags.NO_AUTO_START,
            ctx.remaining(250), None).unpack()[0]

    def _state(self, ctx):
        return self.portal.bus.call_sync(self.owner, self.PATH, self.NAME,
            "GetCurrentState", None, GLib.VariantType.new(self.REPLY),
            Gio.DBusCallFlags.NO_AUTO_START, ctx.remaining(250), None).unpack()

    @staticmethod
    def _fingerprint(state):
        # The serial is part of this complete snapshot. Comparing the layout
        # as well catches a changed topology even if an implementation reuses
        # a serial. Hardware identifiers are never returned or logged.
        return json.dumps(state, sort_keys=True, separators=(",", ":"), allow_nan=False)

    def _validate_streams(self, state):
        serial, monitors, logicals, properties = state
        if (not integer(serial, 0, 0xffffffff) or not isinstance(properties, dict)
                or not 1 <= len(monitors) <= 64 or not 1 <= len(logicals) <= 64):
            raise ValueError("Unsupported DisplayConfig state")
        modes = {}
        for spec, choices, _properties in monitors:
            spec = tuple(spec)
            if len(spec) != 4 or spec in modes or not all(isinstance(value, str) for value in spec):
                raise ValueError("Ambiguous monitor identity")
            current = [choice for choice in choices if choice[6].get("is-current") is True]
            if len(current) != 1:
                # Disconnected or inactive outputs are part of the frozen
                # fingerprint but cannot be selected for input.
                modes[spec] = None
                continue
            width, height = current[0][1:3]
            if not integer(width, 1, 32768) or not integer(height, 1, 32768):
                raise ValueError("Invalid monitor dimensions")
            modes[spec] = (width, height)
        eligible = []
        for x, y, scale, transform, _primary, specs, _properties in logicals:
            if (not integer(x, -0x7fffffff, 0x7fffffff)
                    or not integer(y, -0x7fffffff, 0x7fffffff)
                    or type(scale) not in (float, int) or scale != 1.0 or transform != 0):
                continue
            dimensions = [modes.get(tuple(spec)) for spec in specs]
            if not dimensions or any(value is None or value != dimensions[0] for value in dimensions):
                continue
            eligible.append((x, y, dimensions[0][0], dimensions[0][1]))
        matched = set()
        for stream in self.portal.streams:
            position, size, display = stream.get("position"), stream.get("logical"), stream.get("display")
            if (not isinstance(position, (list, tuple)) or len(position) != 2
                    or not all(integer(value, -0x7fffffff, 0x7fffffff) for value in position)
                    or not isinstance(size, (list, tuple)) or len(size) != 2
                    or not all(integer(value, 1, 32768) for value in size)
                    or not isinstance(display, dict)
                    or (display.get("width"), display.get("height")) != tuple(size)):
                raise ValueError("Stream geometry cannot be bound to current monitor")
            geometry = (*position, *size)
            if eligible.count(geometry) != 1 or geometry in matched:
                raise ValueError("No unique unscaled and unrotated monitor matches the stream")
            matched.add(geometry)
        if not matched or len(matched) != len(self.portal.streams):
            raise ValueError("No monitor mapping")

    def _fence(self):
        self.fenced.set()
        self.available = False
        self.reason = "The GNOME display layout or its service changed. Input is disabled for this grant; run computer_setup again. Capture remains available."

    def _monitors_changed(self, *_args):
        if not self.closed:
            self._fence()

    def _owner_changed(self, _connection, _sender, _path, _interface, _signal, parameters, *_args):
        _name, old, new = parameters.unpack()
        if not self.closed and self.owner and (old == self.owner or new != self.owner):
            self._fence()

    def check(self, ctx):
        ctx.check()
        if self.fenced.is_set():
            raise Failure("display_changed", self.reason)
        if not self.available or self.closed:
            raise Failure("input_unavailable", self.reason)
        try:
            if self._owner(ctx) != self.owner or self._fingerprint(self._state(ctx)) != self.snapshot:
                self._fence()
        except Exception:
            ctx.check()
            self._fence()
        if self.fenced.is_set():
            raise Failure("display_changed", self.reason)
        ctx.check()

    def close(self):
        self.closed = True
        self.available = False
        for subscription in self.subscriptions:
            try:
                self.portal.bus.signal_unsubscribe(subscription)
            except Exception:
                pass
        self.subscriptions = []
`;
