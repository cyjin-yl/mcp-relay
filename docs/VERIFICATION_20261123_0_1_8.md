# Verification: computer use 0.1.8

This record distinguishes source/build checks, native OS acceptance, the public release channel, and actual device installation. An artifact upload or CI success is not a physical device installation receipt.

## Change and provenance

- Feature branch: `feat/computer-use-20261123`.
- Draft review: https://github.com/cyjin-yl/mcp-relay/pull/4 (builds on the Windows/supervised-update work in #3).
- Computer tools: `computer_info`, `computer_screenshot`, `computer_action`, `computer_handoff`, `computer_setup`.
- Platform backends: Windows Win32, macOS Quartz/JXA (primary display), Linux X11, rooted Android.
- The standalone package contains the first-party signed Android Unicode input bridge. APK SHA-256: `3159ff9b0e654b4c0d5fbea4cdc9ac568f4ed136c114f0171c8760f030432636`; size 25,049 bytes.
- All development builds and tests run in the CT102 development containers. Native CI consumes prebuilt, same-origin SHA-256-pinned artifacts.

## Completed source/build checks

The 2026-11-23 build passed TypeScript checking and all **160 tests in 22 files**. Coverage includes native process cancellation/output limits, cross-platform backend boundaries, screenshot-frame and request-ID constraints, persistent configuration revisions, real WebSocket image transport and handoff, and 25 supervisor tests.

Supervisor verification includes real forked workers: active-work drain, persistent-kernel deferral, candidate readiness, failure recovery, same-version local reload, startup request consumption, and the configuration revision A -> disable -> B race. A ready candidate for A cannot consume B.

Six checks against the built standalone CLI passed: enable, pause preservation, resume, disable, sidecar permissions, and unchanged credential bytes. Native process lifecycle regressions also prove that an error from a process with a PID is not mistaken for exit; the UI transaction remains owned through real process termination.

Linux native acceptance used an isolated Xvfb desktop and an owned Tk window. Native PNG dimensions (1024 x 768), Chinese and emoji text, keyboard chord, click, drag, scrolling, cancelled drag cleanup, and a fresh post-cancel screenshot passed. Unicode input needed an XTEST inter-key delay; the tested implementation uses 20 ms.

Go tests and binary build passed. The production server binary with native-image support was deployed and health/readiness verified on 2026-11-23 at 16:46 UTC. Executable SHA-256: `b10e470c9e936abfa2a7dc5d8e66909107051ffa16d109daa779d06836cb0b41`. The registered-device WebSocket budget is 20 MiB and decoded image budget 12 MiB; hello and HTTP limits remain 1 MiB. Input/setup/handoff enforce write scope. The existing kernel worker identities were retained.

## Native acceptance and release gate

Native CI must bind its receipt to the exact final standalone CLI and harness digests. The workflow exercises the actual CLI against an owned GUI window, rather than testing only a separately compiled backend.

- First diagnostic run: https://github.com/cyjin-yl/mcp-relay/actions/runs/45220878924.
- Second diagnostic run: https://github.com/cyjin-yl/mcp-relay/actions/runs/45225459210.
- In the second run, Windows PowerShell 7 verified runtime identity, screenshots, coordinates, Unicode, shortcuts, click, drag and scrolling. A post-cancellation screenshot encountered the still-held cleanup lock; its harness must wait in a bounded way using read-only observations and must never replay the action.
- PowerShell 5.1 was observed as the actual child executable, but helper and version probes timed out. The timeout is an unresolved compatibility finding, not a native pass.
- macOS display enumeration reached the native session checks with capture/input permissions granted. Its console-session dictionary key handling misclassified an available session; the resulting blocked receipt is not accepted as a genuine permission boundary or a UI pass.

Third diagnostic run: https://github.com/cyjin-yl/mcp-relay/actions/runs/45228330569. Windows PowerShell 7 passed all 10 native cases using the actual 7.6.10 Core runtime. macOS confirmed the actual console-session key and granted permissions; its owned test window then exposed a JXA subclass signature mismatch in the fixture. PowerShell 5.1 timed out while downloading an artifact, before any native or startup diagnostic code ran. That download failure provides no new PowerShell compatibility result.

**Stable client promotion remains pending a corrected native acceptance run.** The stable channel is still 0.1.7 at the time of this record. Candidate upload alone does not publish 0.1.8.

## Physical device rollout state

- Existing Linux relay: its persistent kernel worker remains active. Computer enablement is prepared without changing credential bytes; migration waits for the already-established safe condition. This does not claim the new tools are registered yet.
- Windows laptop: currently offline. A previous trusted-SSH deployment reached identity verification and then timed out during file transfer. The remote journal and current runtime must be reconciled before another installation; a timeout does not prove that no remote side effect occurred.
- Android: the previously verified 0.1.7 OTA remains the last physical acceptance. The new computer feature, APK setup and owned ProbeActivity acceptance await connectivity.

The existing persistent follow-up task must retain these pending states and use the final release digests. After upgrade, use the verified **new CLI** for computer management commands; the old bootstrap does not forward new subcommands. An enable/reload receipt is followed by fresh registration and a real `computer_info` callback. See [the deployment runbook](../deploy/computer/runbook.md).

## Known capability limits

- Linux supports native X11 with xdotool and ImageMagick. Full Wayland desktop control is not advertised through XWayland.
- macOS secondary displays are diagnostic only until native capture/display-index mapping has been verified.
- Locked/secure desktops, missing OS grants and missing interactive sessions are reported as unavailable; the relay does not grant permissions or unlock a device.
- Android requires an already authorized su path. The optional setup installs only the signed first-party input bridge; text operations restore the previous selected/enabled IME state.
- Uncertain input outcomes are observed, not automatically replayed. Screenshot/action evidence remains in the owned test environment.
- The HTTPS update channel and npm publication are separate; no npm publication is claimed.
