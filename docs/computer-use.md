# Native computer use — device 0.1.12

The optional computer pack adds computer_info, computer_screenshot, computer_action,
computer_handoff, computer_setup, and computer_session. Screenshots are native MCP PNG image blocks,
with metadata kept separate from base64 image content. Action, handoff, setup, and session lifecycle
always require relay.write, even if a device incorrectly marks them read-only.

Platform requirements and recovery behavior are described below. The [deployment runbook](../deploy/computer/runbook.md) covers activation, both target modes, and native acceptance. A source version or successful build alone does not establish that stable or npm has been published.

## Enablement and local controls

Use the verified installed client and the same config as the running device:

    node /path/to/cli.cjs computer-enable --config /path/to/device.json
    node /path/to/cli.cjs computer-status --config /path/to/device.json

Enablement is stored beside, separately from, the device credential file. New workers
automatically add the computer pack when enabled, including workers started by an
older update supervisor. computer-enable also requests a managed reload using the
currently verified release, after active work drains. A live persistent kernel
defers this reload. If no supervisor is running, the setting applies at the next
managed start. Inspect update-status.reload for queued/deferred/completed results.

A new connection can opt in with:

    node /path/to/cli.cjs connect --packs minimal,omp,computer --allow-computer --root /your/project

Computer control accesses the selected OS desktop or PVE virtual console and is
not confined by the file tools' --root. It does not grant OS permissions, accept su
prompts, unlock a desktop, or authorize unrelated account actions.

Local control changes take effect during an operation:

    node /path/to/cli.cjs computer-pause --config /path/to/device.json
    node /path/to/cli.cjs computer-resume --config /path/to/device.json
    node /path/to/cli.cjs computer-disable --config /path/to/device.json

Native cleanup completes before the desktop transaction lock is released. Pause
persists across updates; screenshots remain available while paused. Disable also
blocks screenshots. A fresh screenshot is required after handoff.

## Choose foreground or isolated control

Both modes remain available. The model chooses the target that fits the user's task.

| Intent | Tool flow | Target |
| --- | --- | --- |
| Work in the user's current application | Call info/screenshot/action without a lease_id | The existing foreground desktop or explicitly selected PVE console |
| Work without sharing the foreground keyboard, pointer or focus | Open computer_session with mode isolated, then pass its lease_id to info/screenshot/action | The leased private workspace |

An isolated failure never redirects an action to the foreground. Foreground frames
cannot be used in an isolated workspace, and workspace frames cannot be used for
foreground input. Switching mode requires a fresh screenshot of the selected target.
Foreground control retains the existing opt-in, local pause, scopes and frame checks.

For explicit workspace runtime installation, use:

~~~json
{"workspace": true, "timeout_ms": 120000}
~~~

with computer_setup. This route does not run the foreground Android IME installer.
Inspection and session creation do not download software or grant OS permissions.

Open a workspace:

~~~json
{
  "operation": "open",
  "mode": "isolated",
  "request_id": "research-workspace-1",
  "width": 1600,
  "height": 1000,
  "idle_timeout_ms": 120000,
  "max_duration_ms": 1800000
}
~~~

The result includes lease_id, expiry, capabilities and recovery mode. A supported
launch specification can start an application directly in the private workspace.
Providers refuse unsupported adoption of existing foreground windows; they do not
silently move unrelated applications.

Linux gives launched applications a persistent home and XDG configuration, data,
cache and state directories owned by that lease. This keeps ordinary browser and
other single-instance application profiles separate from the foreground session.
Known profile and existing-instance override options are rejected before launch.
To use an already-open application or its existing sign-in state, choose foreground
mode. The private application home is preserved with the workspace after handoff;
recovery does not delete its files. Use applications that honor these directories. Custom launchers that hard-code
another profile or connect to another display can still affect that other session.

On Windows, the default open attempts native automatic sign-in with its viewer
hidden. If Windows requires credentials, it fails closed and returns its owned
resources; the model must not type credentials into the user's desktop. When the
user is present and explicitly chooses to sign in, add `interactive_sign_in: true`
to the open request. Only this option displays the native Windows sign-in viewer.
The original lease stays in `preparing` with no agent input capability while the
user signs in. After native readiness, child-session identity and PointerGuard are
verified, the viewer hides and that same lease becomes active. The default call
budget becomes 120 seconds, still bounded by the lease and authorization expiry;
an explicit shorter `timeout_ms` remains authoritative. Signing in does not imply
that Windows will automatically authenticate future sessions. Other platforms
reject this Windows-only option.

Capture and act using the same lease:

~~~json
{"lease_id": "<lease UUID>", "timeout_ms": 30000}
~~~

~~~json
{
  "lease_id": "<lease UUID>",
  "request_id": "research-click-1",
  "frame_id": "<fresh workspace frame>",
  "action": {"type": "click", "x": 320, "y": 180},
  "screenshot_after": true
}
~~~

Use computer_session with operation renew, the lease_id, a new request_id and
extend_ms while work continues. The default idle lease is two minutes; ordinary
screenshots and native watchdog heartbeats do not silently extend it. The default
hard lifetime is thirty minutes, also bounded by the authenticated token's expiry.
Close explicitly when finished:

~~~json
{"operation": "close", "lease_id": "<lease UUID>", "request_id": "research-close-1"}
~~~

### Workspace providers and recovery

| Platform | Isolation | Return path and requirements |
| --- | --- | --- |
| Windows | Native Child Session; independent desktop/input; pinned Anode runtime with verified PointerGuard | Agent input is revoked and the retained session viewer is placed on the physical desktop. Cross-session application windows cannot be reparented into the user's session. Child Sessions and a successful native Windows login are required. |
| Linux | Private Xvfb/X11 server and Xpra; physical clipboard, audio and file forwarding disabled | Applications remain alive in a visible Xpra viewer on the original desktop. Requires Xpra, Xvfb, xauth, xdotool, Openbox, ImageMagick, python3-xlib and python3-pil, plus a working physical X11/XWayland return target. |
| Rooted Android 14+ | Trusted VirtualDisplay with OWN_FOCUS and STEAL_TOP_FOCUS_DISABLED; display-targeted input and capture | The helper moves surviving tasks to display 0, releases its own display and confirms removal. It does not switch the global IME or use the clipboard. Isolated text is currently ASCII only. |
| macOS | Unavailable for generic isolated native application input | Existing foreground computer use remains available. The reviewed virtual-display route has incomplete focus-route verification and unsafe abandoned-app termination defaults, so relay creates no virtual display through it. |

These are input workspaces, not application security sandboxes. Applications still
run with the device user's account and file permissions. Android applications also
share that user's system clipboard; workspace tools never access it and reject
clipboard shortcuts. The reported clipboardBoundary makes this distinction explicit.

Closing, expiry, lost relay connection, local pause/disable or authorization
revocation first fences further agent input, then starts recovery. Stateless HTTP
request completion is not treated as a disconnect: idle expiry covers a client that
simply stops renewing. Device WebSocket loss and a stale authenticated transport are
separate recovery signals. Revoking a temporary share also revokes its already-open
workspaces after the original HTTP call has completed.

A separate broker owns each lease. Native platform guardians have their own clocks
and liveness checks, so killing the relay worker cannot leave an unlimited lease.
A durable revocation marker fences delayed task/helper startup as well as later
input. Resource journals and exact instance/process identity prevent cleanup from
targeting a reused display ID or another session.

Recovery never closes unsaved applications just to remove a display. A visible
handoff viewer is the return mechanism for platforms that cannot move a window
across login/X11 sessions. No physical monitor is added by the Windows or Linux
providers. If the return target is unavailable, status reports cleanup_pending,
agent input remains disabled and recovery retries. It does not report success
until a return receipt is verified. Active leases and unresolved cleanup defer
automatic updates.

Windows shell calls use both hidden native spawning and PowerShell's explicit
hidden window mode. Persistent task launchers use the GUI Windows Script Host with
a private hidden child, rather than opening a console through Task Scheduler.
Explicit native OS login or permission dialogs remain visible when setup needs them;
normal command execution must not open a PowerShell/Terminal window.

## Platform backends

| Platform | Native implementation | Requirements |
| --- | --- | --- |
| Windows | Win32 capture, physical display coordinates, SendInput and UTF-16 text | Interactive user session; PowerShell 7 or Windows PowerShell 5.1 |
| macOS (primary screen) | Quartz/JXA input, screencapture, Retina coordinate conversion | Aqua desktop; locally granted Screen Recording and Accessibility permissions |
| Linux X11 | ImageMagick capture; XTEST via xdotool | Intended DISPLAY/XAUTHORITY; ImageMagick and xdotool |
| Linux Wayland | RemoteDesktop and ScreenCast portals; authorized PipeWire PNG capture and EIS input, with guarded compatibility for older GNOME desktops | Desktop session bus; distribution Python with PyGObject/GStreamer; PipeWire capture plugin; a portal backend providing both interfaces; explicit local consent; libei and libxkbcommon for EIS |
| Proxmox local QEMU VMs | Host VM discovery and QEMU virtual-console capture/input | PVE host access to qm and the selected VM's monitor; a guest virtual display |
| Android | su, screencap, input, rotation checks, signed Unicode IME | Existing authorized su; system toybox timeout; Android 6+ for the bridge |

Windows Session 0, locked/secure desktops, headless systems, and missing permissions
are reported explicitly. The implementation does not change UAC, SELinux, lock-screen
settings, or permission databases. Protected applications may refuse capture/input.

Wayland uses the portal backend even when DISPLAY also names an XWayland server.
It does not bypass portal consent or enable compositor unsafe/debug modes.

macOS secondary displays are listed for diagnosis but capture/input are refused in this release, because native screenshot numbering has not been verified against display IDs.

Linux X11 Unicode input uses paced XTEST key mapping. Native acceptance covers Chinese,
ASCII, and supplementary Unicode in a real test widget. Target application input
handling can still differ; an input submission receipt is not proof of the intended
application result.

### Wayland permission sessions

Run relay in the intended user's graphical session. It needs that session's
WAYLAND_DISPLAY, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS. A background service
without those desktop connections cannot discover or control another user's session.
The bundled helper uses the distribution Python at /usr/bin/python3 when present;
install PyGObject and GStreamer for that interpreter, not only in a virtual environment.
Required GStreamer elements are pipewiresrc, videoconvert, capsfilter, pngenc and appsink.
On Debian/Ubuntu the relevant packages include python3-gi,
gir1.2-gstreamer-1.0, gstreamer1.0-pipewire, gstreamer1.0-plugins-base and
gstreamer1.0-plugins-good, plus PipeWire, xdg-desktop-portal and the backend for the
active desktop. A compositor exposing ScreenCast without RemoteDesktop is reported
as unavailable for input; relay does not fall back to XWayland control.

1. Enable the computer pack using the existing local opt-in.
2. Call computer_info to inspect dependencies and portal capabilities. This does not
   prompt, select a monitor, or grant a permission.
3. Call computer_setup on the **connected worker** with `{"timeout_ms":120000}`.
   The local desktop user selects one to eight existing monitors and approves
   keyboard and pointer access in the system dialog. Cancelling leaves control
   unavailable. The one-shot `computer-setup` CLI reports that setup must occur in
   the worker: an OS permission handle cannot be transferred between those processes.
4. Inspect the returned display IDs, then capture with the selected display_id.
   Multiple shared monitors require explicit selection. Send actions using the
   returned frame_id and screenshot pixel coordinates, as for other platforms.

Each capture opens a fresh authorized PipeWire connection and encodes its current
frame as PNG. It does not reuse a screenshot cached before an input operation.
Display identity includes the permission session and stream identity. Before input,
the helper rechecks the capture dimensions and rejects stale geometry. Input support
depends on the desktop's available mapping protocol:

| Desktop capability | Input behavior |
| --- | --- |
| RemoteDesktop EIS connection and ScreenCast monitor mapping IDs, with a compatible libei and libxkbcommon | Each shared monitor must match one live EIS region. Screenshot pixels map to that region's coordinates, including scaled monitors. Device replacement or region changes invalidate prior frames. The compositor supplies the keyboard map. |
| Older GNOME portal without usable EIS | Pointer actions are limited to unrotated monitors at scale 1. Relay freezes the read-only Mutter DisplayConfig state before consent, binds the selected streams to that unchanged layout, and checks the owner, serial and layout before each input event. A display change requires fresh setup. Keyboard and text actions are unavailable because this protocol does not supply the compositor keymap and modifier state needed for reliable text. |
| Other authorized capture with no reliable input mapping | Screenshots remain available; input is disabled and `computer_info` explains the missing capability. |

The EIS library must expose monitor mapping and synchronization support; Debian
package names include `libei1` and `libxkbcommon0`. After connecting EIS, relay never
falls back to legacy Notify input within that permission session. `computer_info`
reports the active transport in `details.inputTransport`. The helper does not
change monitor settings, keyboard layouts or desktop permission databases.
Pointer and keyboard capabilities are reported separately in `actions`; an absent
or unsupported keyboard map does not imply that keyboard input is available.
On older ScreenCast portals that do not supply a stable PipeWire stream serial,
an observed monitor or capture-geometry change closes the grant. Run setup again
before capturing or acting, so a reused PipeWire node ID cannot become an old
frame's new target.

Permissions last only for the current worker connection. Disconnecting, pausing,
disabling computer control, cancelling a request, losing the portal, or leaving the
helper idle for five minutes releases the session. A local pause/resume pair also
invalidates it through the settings revision. After reconnect or resume, explicitly
run computer_setup and capture a new frame. Restore tokens are not saved, no system
permission database is modified, and the helper has no listening network socket.
Held keys and buttons are released on cancellation where the portal remains available;
closing the DBus connection also ends the compositor's remote input session.

Wayland text is available through EIS and supports **printable ASCII only**. The active compositor
keyboard map must represent the complete string using unmodified or Shift keys;
unsupported characters are rejected before input begins. Unicode and control
characters are also rejected, including embedded newline and tab; use explicit key
actions for Enter or Tab. No clipboard is read or changed. Keyboard layout or
modifier changes can interrupt a text operation; application handling and concurrent
local input can still affect the result. Follow input with a fresh screenshot to
verify the application result.

This portal path operates the selected foreground monitor. Isolated Linux workspaces
remain the existing Xpra/Xvfb provider and still need a verified X11/XWayland return
target for the application-preserving handoff. A portal virtual-monitor capability
alone does not establish isolated input, application routing or safe window recovery.

Protocol references: [RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html),
[ScreenCast](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html),
[Request lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html)
and [Session lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Session.html).

## Proxmox VM consoles

The PVE host backend exposes local QEMU VMs through the same computer tools. Use
computer_info to inspect the VM inventory and current availability, then select a
VM with `display_id: "pve:<VMID>"`. The selected ID is accepted by computer_info
and computer_screenshot, for example:

```json
{"display_id":"pve:123"}
```

Retain the screenshot's frame_id and use the normal computer_action arguments:

```json
{
  "request_id": "pve-123-click-1",
  "frame_id": "<frame from pve:123>",
  "action": { "type": "click", "x": 320, "y": 180 },
  "screenshot_after": true
}
```

computer_action has no separate display_id argument: the frame binds the action
to its VM. A different target, changed display geometry, or a restarted VM instance
requires a new screenshot; reusing the same VMID does not make an old frame valid.
The usual pause, frame-expiry, request-deduplication, and uncertain-outcome rules
apply. This interface does not expose an arbitrary qm command tool.

Capture is the QEMU virtual display. A physical monitor driven only by a GPU passed
through to the guest is not captured through that display. LXC containers are not
QEMU virtual displays. Inspect each target's reported capabilities before input.
PVE text input assumes a US keyboard layout and supports ASCII only;
`unicodeText: false` accurately reports that limitation. Non-ASCII input must not
be treated as successfully typed.

PVE scrolling supports only `up` and `down`. Requests for `left` or `right` return
`unsupported_action`; a QMP acknowledgement alone does not establish that the
guest received horizontal wheel input. This restriction applies to the PVE
backend; other platforms retain their own reported scroll capabilities.

The relay device is the PVE host, so a temporary share of that device can access
its enabled computer tools across the host's VMs, including VMs added later. Share
scope still limits read versus input, but there is no VM-subset restriction within
a device share. Selecting one VM for an action does not narrow the share itself.

## Android Unicode bridge

Run computer_setup (or computer-setup locally) explicitly to install the bundled
signed, SHA-256 checked bridge. No user application is replaced. Its receiver is
signature-permission protected; delivery uses the existing privileged root channel.
The bridge does not read surrounding document text.

UTF-8 text is transported as base64 and committed through the active InputConnection.
The original selected/enabled IME state is restored in cleanup. The exact request ID
must be acknowledged. input text is not used as a pretend Unicode implementation.

Android coordinate input requires consistent current default-display geometry and rotation.
Base display dimensions or embedded Configuration rotation fields do not override the
current display state. When that state cannot be established, capture remains observable
and coordinate actions are refused; inspect the reported capabilities before input.

Every Android action retains the application identity from its screenshot. After su
returns, the privileged input session must confirm the same default-display component
in consecutive observations. Text checks again after selecting the temporary IME.
A different or unverified target stops input; a later probe cannot retarget the action.
Bridge failures expose only bounded, exact-request status categories, and uncertain
input is not replayed.

MCP setup failures identify preflight, install, or verification. A failed verification
after installation remains mayHaveApplied=true. Only bounded package-manager
failure codes or static diagnostic categories are returned; native output and
paths are omitted. Reconcile the installed package before retrying an uncertain
setup.

Privileged actions have their own watchdog: the Termux su client's exit alone does
not prove that root work ended. Unknown/cancelled outcomes wait for bounded cleanup
and report mayHaveApplied; they are never automatically replayed. First-time su
authorization may show the system's prompt, which requires local user approval.

## Observation and action

1. Inspect computer_info for availability, permissions, displays, and supported actions.
2. Observe computer_screenshot and retain frame_id.
3. Call computer_action with a new request_id, that frame_id, and one action.
4. Observe again before the next action.

Example:

    {
      "request_id": "edit-title-1",
      "frame_id": "<latest screenshot id>",
      "action": { "type": "click", "x": 320, "y": 180 },
      "screenshot_after": true
    }

Actions are move (x/y), click (x/y, optional button/clicks), drag
(fromX/fromY/toX/toY/durationMs), scroll (direction, optional amount and x/y),
key (keys array such as ["Ctrl","a"]), and text (text without automatic Enter).
Android combinations require native keycombination support.

Scroll amount is an integer number of steps from 1 through 40; the default is 3.
On Android each step becomes a 120-pixel swipe distance in the screenshot coordinate
grid, bounded to 75% of the selected screen axis. Other backends deliver native
wheel/line steps, so the visible distance still depends on the target application.

Coordinates are actual screenshot pixels, including on Retina/high-DPI screens.
The backend converts to native input units. Frames expire after two minutes.
Changed display geometry, rotation, or known foreground application invalidates a
frame. Every attempted action consumes preceding observations.

An exact request_id retry returns its cached receipt without replaying input in the
same worker. Conflicting reuse is rejected. A restart invalidates old frame IDs,
so a request cannot be replayed simply because the in-memory receipt cache was lost.
Observe again after a timeout or uncertain outcome. Receipts store no input text or
image payload; screenshots are not copied into routine audit logs.

## Bounds and updates

Default deadline: 30 seconds; accepted timeout_ms: 1–120000, with a separate bounded
server cleanup allowance. Text: at most 16384 UTF-16 code units and 64 KiB UTF-8.
PNG: at most 12 MiB decoded. Registered-device WebSocket messages: at most 20 MiB.
Hello/pairing and HTTP request limits stay at 1 MiB.

A kernel-owned desktop transaction lock prevents simultaneous input from different
relay configs for the same OS user. Native helpers use bounded commands and release
only input held by the operation.

The existing updater checks manifest/SHA-256, preflights the candidate, drains work,
requires authenticated readiness, and rolls back failed activation. The bridge is
part of the standalone client release. Persistent kernel state still blocks worker
replacement until safely released. A local feature reload reuses the current
verified bundle and the same drain/readiness/recovery gates; it does not fetch an
untrusted release, downgrade the device, or discard release history.

## Evidence

Development builds and tests run in CT102. Native harnesses use only their own
harmless windows or the Android bridge's ProbeActivity. Windows/macOS jobs verify
and execute the prebuilt client and harness by SHA-256. A permission-blocked runner
is recorded as blocked, not as a successful full desktop test. Unit, CI, and actual
device acceptance must be reported separately.
