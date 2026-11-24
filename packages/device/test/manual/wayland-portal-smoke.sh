#!/usr/bin/env bash
set -euo pipefail

# This file must run under dbus-run-session in a disposable runner/container.
# Xvfb is only the outer host of a real nested Mutter Wayland compositor. The
# tested GTK application and helper have no DISPLAY and cannot use XWayland.
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
export RELAY_WAYLAND_NATIVE_TEST=nested-mutter-private-bus
export MUTTER_DEBUG_NUM_DUMMY_MONITORS=1
export MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1200
export MUTTER_DEBUG_DUMMY_MONITOR_SCALES="${RELAY_TEST_SCALE:-1}"
relay_outer_display=:89
relay_owned_pids=()
relay_cleanup() {
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

Xvfb "$relay_outer_display" -screen 0 1600x1200x24 -nolisten tcp \
  > "$RELAY_NATIVE_EVIDENCE_DIR/xvfb.log" 2>&1 &
relay_owned_pids+=("$!")
for relay_attempt in {1..50}; do
  if DISPLAY="$relay_outer_display" xdpyinfo >/dev/null 2>&1; then break; fi
  sleep 0.1
done
DISPLAY="$relay_outer_display" xdpyinfo >/dev/null

relay_mutter_args=(--wayland --no-x11 --wayland-display="$WAYLAND_DISPLAY")
if mutter --help | rg -q -- '--nested'; then relay_mutter_args+=(--nested); fi
DISPLAY="$relay_outer_display" GDK_BACKEND=x11 mutter "${relay_mutter_args[@]}" \
  > "$RELAY_NATIVE_EVIDENCE_DIR/mutter.log" 2>&1 &
relay_owned_pids+=("$!")
for relay_attempt in {1..100}; do
  if test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"; then break; fi
  sleep 0.1
done
test -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
unset DISPLAY

dbus-update-activation-environment XDG_RUNTIME_DIR XDG_CONFIG_HOME XDG_DATA_HOME \
  XDG_SESSION_TYPE XDG_CURRENT_DESKTOP WAYLAND_DISPLAY GDK_BACKEND GTK_A11Y \
  NO_AT_BRIDGE LIBGL_ALWAYS_SOFTWARE GSK_RENDERER LANG LC_ALL
gsettings set org.gnome.desktop.interface toolkit-accessibility true
gdbus call --session --dest org.a11y.Bus --object-path /org/a11y/bus \
  --method org.a11y.Bus.GetAddress > "$RELAY_NATIVE_EVIDENCE_DIR/a11y-address.txt"

pipewire > "$RELAY_NATIVE_EVIDENCE_DIR/pipewire.log" 2>&1 &
relay_owned_pids+=("$!")
wireplumber > "$RELAY_NATIVE_EVIDENCE_DIR/wireplumber.log" 2>&1 &
relay_owned_pids+=("$!")
for relay_attempt in {1..50}; do
  if test -S "$XDG_RUNTIME_DIR/pipewire-0"; then break; fi
  sleep 0.1
done
test -S "$XDG_RUNTIME_DIR/pipewire-0"

/usr/libexec/xdg-desktop-portal-gnome \
  > "$RELAY_NATIVE_EVIDENCE_DIR/portal-gnome.log" 2>&1 &
relay_owned_pids+=("$!")
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

node release/wayland-portal-smoke.cjs
