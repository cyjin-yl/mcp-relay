# Native computer use — device 0.1.8

The optional computer pack adds computer_info, computer_screenshot, computer_action,
computer_handoff, and computer_setup. Screenshots are native MCP PNG image blocks,
with metadata kept separate from base64 image content. Action, handoff, and setup
always require relay.write, even if a device incorrectly marks them read-only.

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

Computer control accesses the logged-in desktop and is not confined by the file
tools' --root. It does not grant OS permissions, accept su prompts, unlock a desktop,
or authorize unrelated account actions.

Local control changes take effect during an operation:

    node /path/to/cli.cjs computer-pause --config /path/to/device.json
    node /path/to/cli.cjs computer-resume --config /path/to/device.json
    node /path/to/cli.cjs computer-disable --config /path/to/device.json

Native cleanup completes before the desktop transaction lock is released. Pause
persists across updates; screenshots remain available while paused. Disable also
blocks screenshots. A fresh screenshot is required after handoff.

## Platform backends

| Platform | Native implementation | Requirements |
| --- | --- | --- |
| Windows | Win32 capture, physical display coordinates, SendInput and UTF-16 text | Interactive user session; PowerShell 7 or Windows PowerShell 5.1 |
| macOS (primary screen) | Quartz/JXA input, screencapture, Retina coordinate conversion | Aqua desktop; locally granted Screen Recording and Accessibility permissions |
| Linux X11 | ImageMagick capture; XTEST via xdotool | Intended DISPLAY/XAUTHORITY; ImageMagick and xdotool |
| Android | su, screencap, input, rotation checks, signed Unicode IME | Existing authorized su; system toybox timeout; Android 6+ for the bridge |

Windows Session 0, locked/secure desktops, headless systems, and missing permissions
are reported explicitly. The implementation does not change UAC, SELinux, lock-screen
settings, or permission databases. Protected applications may refuse capture/input.

Wayland is detected separately. This release does not treat XWayland as full-desktop
control; it reports the need for a compositor-approved RemoteDesktop portal backend.
It does not bypass portal consent or enable compositor unsafe/debug modes.

macOS secondary displays are listed for diagnosis but capture/input are refused in this release, because native screenshot numbering has not been verified against display IDs.

Linux Unicode input uses paced XTEST key mapping. Native acceptance covers Chinese,
ASCII, and supplementary Unicode in a real test widget. Target application input
handling can still differ; an input submission receipt is not proof of the intended
application result.

## Android Unicode bridge

Run computer_setup (or computer-setup locally) explicitly to install the bundled
signed, SHA-256 checked bridge. No user application is replaced. Its receiver is
signature-permission protected; delivery uses the existing privileged root channel.
The bridge does not read surrounding document text.

UTF-8 text is transported as base64 and committed through the active InputConnection.
The original selected/enabled IME state is restored in cleanup. The exact request ID
must be acknowledged. input text is not used as a pretend Unicode implementation.

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
