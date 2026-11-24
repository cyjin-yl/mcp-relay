#!/bin/bash
set -euo pipefail
: "${RELAY_MAP_PROBE_DIR:?}"
mkdir -p "$RELAY_MAP_PROBE_DIR/runtime"
chmod 700 "$RELAY_MAP_PROBE_DIR/runtime"
export XDG_RUNTIME_DIR="$RELAY_MAP_PROBE_DIR/runtime" XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME WAYLAND_DISPLAY=wayland-map-probe GDK_BACKEND=wayland LIBGL_ALWAYS_SOFTWARE=1
unset DISPLAY DESKTOP_STARTUP_ID XDG_ACTIVATION_TOKEN
mutter --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" --virtual-monitor=1600x1200 > "$RELAY_MAP_PROBE_DIR/mutter.log" 2>&1 &
relay_mutter_pid=$!
trap 'kill "$relay_mutter_pid" 2>/dev/null || true' EXIT
for relay_attempt in {1..100};do test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" && break; sleep .1;done
test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
/usr/bin/python3 packages/device/test/manual/wayland-workspace-return-probe.py
