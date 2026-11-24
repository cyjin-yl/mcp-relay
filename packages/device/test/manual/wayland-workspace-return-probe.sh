#!/usr/bin/env bash
set -euo pipefail
: "${DBUS_SESSION_BUS_ADDRESS:?Run under dbus-run-session}"
: "${RELAY_MAP_PROBE_DIR:?}"
case "$RELAY_MAP_PROBE_DIR" in
  "$PWD"|"$PWD"/*) echo 'Probe measurements must be outside the source checkout' >&2; exit 2 ;;
  /*) ;;
  *) echo 'Probe measurements need an absolute directory' >&2; exit 2 ;;
esac
mkdir -p "$RELAY_MAP_PROBE_DIR/runtime"
chmod 700 "$RELAY_MAP_PROBE_DIR/runtime"
export XDG_RUNTIME_DIR="$RELAY_MAP_PROBE_DIR/runtime" XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME
export WAYLAND_DISPLAY=wayland-map-probe GDK_BACKEND=wayland LIBGL_ALWAYS_SOFTWARE=1
export RELAY_MAP_PROBE_DESKTOP=owned-headless-mutter
unset DISPLAY DESKTOP_STARTUP_ID XDG_ACTIVATION_TOKEN
mutter --headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" --virtual-monitor=1600x1200 > "$RELAY_MAP_PROBE_DIR/mutter.log" 2>&1 &
relay_mutter_pid=$!
relay_probe_cleanup() {
  relay_status=$?
  if [ "$relay_status" -ne 0 ]; then
    for relay_log in failure.json mutter.log foreground.log viewer.log no-accept.log; do
      if test -f "$RELAY_MAP_PROBE_DIR/$relay_log"; then tail -n 60 "$RELAY_MAP_PROBE_DIR/$relay_log"; fi
    done
  fi
  kill "$relay_mutter_pid" 2>/dev/null || true
  wait "$relay_mutter_pid" 2>/dev/null || true
}
trap relay_probe_cleanup EXIT
for relay_attempt in {1..100}; do
  test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" && break
  sleep .1
done
test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
/usr/bin/python3 packages/device/test/manual/wayland-workspace-return-probe.py
