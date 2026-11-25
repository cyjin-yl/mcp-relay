#!/usr/bin/env bash
set -euo pipefail

# This file must run under dbus-run-session in a disposable runner/container.
# Mutter's native headless backend owns a real virtual monitor and Wayland
# seat. No outer X11 server or XWayland input translation participates.
: "${DBUS_SESSION_BUS_ADDRESS:?Run this harness with dbus-run-session}"
: "${RELAY_NATIVE_EVIDENCE_DIR:?Choose an evidence directory outside the checkout}"
case "$RELAY_NATIVE_EVIDENCE_DIR" in
  "$PWD"|"$PWD"/*) echo 'Evidence cannot be written in the source checkout' >&2; exit 2 ;;
  /*) ;;
  *) echo 'Evidence directory must be absolute' >&2; exit 2 ;;
esac

mkdir -p "$RELAY_NATIVE_EVIDENCE_DIR" "$RELAY_NATIVE_EVIDENCE_DIR/runtime" \
  "$RELAY_NATIVE_EVIDENCE_DIR/config/xdg-desktop-portal" "$RELAY_NATIVE_EVIDENCE_DIR/data"
chmod 700 "$RELAY_NATIVE_EVIDENCE_DIR/runtime"
export XDG_RUNTIME_DIR="$RELAY_NATIVE_EVIDENCE_DIR/runtime"
export XDG_CONFIG_HOME="$RELAY_NATIVE_EVIDENCE_DIR/config"
export XDG_DATA_HOME="$RELAY_NATIVE_EVIDENCE_DIR/data"
export XDG_SESSION_TYPE=wayland
export XDG_CURRENT_DESKTOP=GNOME
export WAYLAND_DISPLAY=wayland-relay-native
export GDK_BACKEND=wayland
export GTK_A11Y=atspi
export NO_AT_BRIDGE=0
export LIBGL_ALWAYS_SOFTWARE=1
export GSK_RENDERER=cairo
export LANG=C.UTF-8
export LC_ALL=C.UTF-8
export RELAY_WAYLAND_NATIVE_TEST=headless-mutter-private-bus
export RELAY_TEST_COMPOSITOR=headless-native
export RELAY_TEST_VIRTUAL_MONITOR=1600x1200
if [ "${RELAY_TEST_INPUT_TRANSPORT:-}" = eis ]; then
  # Upstream EIS topology traces distinguish a real keymap/device replacement
  # from a monitor-region change when the production input fence fires.
  export MUTTER_DEBUG=eis
else
  # Diagnose the actual compositor queue and device cleanup on the legacy
  # native backend. These upstream topics contain only this owned fixture.
  export MUTTER_DEBUG=remote-desktop,input
fi
relay_owned_pids=()
relay_cleanup() {
  relay_status=$?
  if [ "$relay_status" -ne 0 ]; then
    for relay_log in failure.json portal.log portal-gnome.log pipewire.log wireplumber.log gstreamer.log mutter.log; do
      if test -f "$RELAY_NATIVE_EVIDENCE_DIR/$relay_log"; then
        tail -n 80 "$RELAY_NATIVE_EVIDENCE_DIR/$relay_log"
      fi
    done
  fi
  for relay_pid in "${relay_owned_pids[@]}"; do
    kill "$relay_pid" 2>/dev/null || true
  done
}
trap relay_cleanup EXIT

cat > "$XDG_CONFIG_HOME/xdg-desktop-portal/portals.conf" <<'PORTALS'
[preferred]
default=gnome
org.freedesktop.impl.portal.ScreenCast=gnome
org.freedesktop.impl.portal.RemoteDesktop=gnome
PORTALS

# Give activated settings/portal services the same isolated directories before
# configuring the native compositor. Logical layout makes scale2 a real HiDPI
# mapping test with unchanged physical pixel resolution.
dbus-update-activation-environment XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME \
  XDG_SESSION_TYPE XDG_CURRENT_DESKTOP WAYLAND_DISPLAY GDK_BACKEND GTK_A11Y \
  NO_AT_BRIDGE LIBGL_ALWAYS_SOFTWARE GSK_RENDERER LANG LC_ALL
if gsettings list-keys org.gnome.mutter | rg -qx experimental-features; then
  gsettings set org.gnome.mutter experimental-features "['scale-monitor-framebuffer']"
fi

unset DISPLAY
relay_mutter_args=(--headless --wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY" \
  --virtual-monitor="$RELAY_TEST_VIRTUAL_MONITOR")
mutter "${relay_mutter_args[@]}" \
  > "$RELAY_NATIVE_EVIDENCE_DIR/mutter.log" 2>&1 &
export RELAY_TEST_MUTTER_PID="$!"
relay_owned_pids+=("$RELAY_TEST_MUTTER_PID")
for relay_attempt in {1..100}; do
  if test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"; then break; fi
  sleep 0.1
done
test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
for relay_attempt in {1..50}; do
  if gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetNameOwner org.gnome.Mutter.DisplayConfig >/dev/null 2>&1; then break; fi
  sleep 0.1
done
/usr/bin/python3 packages/device/test/manual/wayland-portal-smoke.py scale "${RELAY_TEST_SCALE:-1}" \
  > "$RELAY_NATIVE_EVIDENCE_DIR/initial-layout.json"

gsettings set org.gnome.desktop.interface toolkit-accessibility true
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
  --method org.a11y.Bus.GetAddress > "$RELAY_NATIVE_EVIDENCE_DIR/a11y-address.txt"

pipewire > "$RELAY_NATIVE_EVIDENCE_DIR/pipewire.log" 2>&1 &
relay_owned_pids+=("$!")
for relay_attempt in {1..50}; do
  if test -S "$XDG_RUNTIME_DIR/pipewire-0"; then break; fi
  sleep 0.1
done
test -S "$XDG_RUNTIME_DIR/pipewire-0"
timeout 5 pw-cli info 0 > "$RELAY_NATIVE_EVIDENCE_DIR/pipewire-core.log"

# The container has no physical Bluetooth seat or systemd-logind. WirePlumber
# 0.4 otherwise treats its optional Bluetooth logind module's activation error
# as fatal. Disable only that unused hardware monitor, keeping real portal
# permissions, PipeWire nodes and normal linking policy intact.
if wireplumber --version | rg -q '0\.4\.'; then
  mkdir -p "$XDG_CONFIG_HOME/wireplumber/bluetooth.lua.d"
  cat > "$XDG_CONFIG_HOME/wireplumber/bluetooth.lua.d/80-relay-native.lua" <<'WIREPLUMBER'
bluez_monitor.enabled = false
WIREPLUMBER
else
  mkdir -p "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d"
  cat > "$XDG_CONFIG_HOME/wireplumber/wireplumber.conf.d/80-relay-native.conf" <<'WIREPLUMBER'
wireplumber.profiles = {
  main = {
    monitor.bluez = disabled
    monitor.bluez-midi = disabled
    monitor.bluez.seat-monitoring = disabled
    support.logind = disabled
  }
}
WIREPLUMBER
fi
wireplumber > "$RELAY_NATIVE_EVIDENCE_DIR/wireplumber.log" 2>&1 &
relay_wireplumber_pid="$!"
relay_owned_pids+=("$relay_wireplumber_pid")
relay_wireplumber_ready=false
for relay_attempt in {1..50}; do
  kill -0 "$relay_wireplumber_pid"
  if timeout 2 pw-cli ls Metadata | rg -q 'metadata.name = "default"'; then
    relay_wireplumber_ready=true
    break
  fi
  sleep 0.1
done
"$relay_wireplumber_ready"
kill -0 "$relay_wireplumber_pid"

/usr/libexec/xdg-desktop-portal-gnome \
  > "$RELAY_NATIVE_EVIDENCE_DIR/portal-gnome.log" 2>&1 &
relay_owned_pids+=("$!")
for relay_attempt in {1..50}; do
  if gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
    --method org.freedesktop.DBus.GetNameOwner org.freedesktop.impl.portal.desktop.gnome \
    >/dev/null 2>&1; then break; fi
  sleep 0.1
done
/usr/libexec/xdg-desktop-portal --verbose \
  > "$RELAY_NATIVE_EVIDENCE_DIR/portal.log" 2>&1 &
export RELAY_TEST_PORTAL_PID="$!"
relay_owned_pids+=("$RELAY_TEST_PORTAL_PID")
relay_portal_ready=false
for relay_attempt in {1..20}; do
  # Waiting on the bus daemon does not auto-activate a competing portal while
  # the explicitly launched process is still acquiring its well-known name.
  if timeout 2 gdbus call --session --dest org.freedesktop.DBus \
    --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.GetNameOwner \
    org.freedesktop.portal.Desktop >/dev/null 2>&1; then
    if timeout 2 gdbus call --session --dest org.freedesktop.portal.Desktop \
    --object-path /org/freedesktop/portal/desktop \
    --method org.freedesktop.DBus.Properties.Get org.freedesktop.portal.RemoteDesktop version \
    > "$RELAY_NATIVE_EVIDENCE_DIR/portal-version.txt" 2>/dev/null; then
      relay_portal_ready=true
      break
    fi
  fi
  sleep 0.2
done
if ! "$relay_portal_ready"; then
  tail -n 80 "$RELAY_NATIVE_EVIDENCE_DIR/portal.log" "$RELAY_NATIVE_EVIDENCE_DIR/portal-gnome.log" \
    "$RELAY_NATIVE_EVIDENCE_DIR/mutter.log"
  exit 1
fi

# Exercise the shipped CLI bundle first. The comprehensive backend harness
# deliberately terminates the private portal daemon in its final check.
node release/wayland-worker-smoke.cjs packages/device/dist/cli.cjs
node release/wayland-portal-smoke.cjs
