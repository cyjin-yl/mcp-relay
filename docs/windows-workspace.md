# Windows isolated computer workspace

The Windows provider uses an owned Anode child session. Foreground computer use remains available through the existing computer tools without a lease ID. Isolated calls use a lease ID and never fall back to the physical desktop.

This isolates the desktop, input and focus path. Applications still run as the same Windows account and share account files and some application state. It is not an application security sandbox. Applications with cross-session singleton or account synchronization behavior need application-specific checks.

## Runtime and prerequisites

The runtime is built from Anode commit cbed84ff7465c0bd0310a3eec20c68046322fb53 (0.11.5) with self-contained .NET 10.0.14, not the older 0.11.4 release. The frozen executable is 76,715,503 bytes with SHA-256:

    cccc59e3b86b0fdfcbe30b3dab8eea7266b104aa92ae29c79fc6d7fd9a3d978a

The runtime must be installed by explicit computer_setup with workspace:true. Open and probe never download software. Setup writes the upstream MIT license and dependency notices beside the executable. The build script and runtime receipt preserve the source commit, binary hash, .NET version and notice hash.

The ordinary signed-in interactive user must create the workspace. Session 0/SSH and elevated brokers cannot create it. Windows child sessions must already be enabled, Remote Desktop Services and its loopback listener must be usable, and the Windows edition must support child sessions. Enabling child sessions is an explicit administrator action. This provider does not alter firewall, credential-delegation, NLA, clipboard, audio, or gamepad policy.

The user must have an available child-session slot. A retained child from a previous handoff is not silently adopted, replaced or logged off.

Primary references:

- [Microsoft child sessions](https://learn.microsoft.com/en-us/windows/win32/termserv/child-sessions)
- [Pinned Anode source](https://github.com/skulitom/Anode/tree/cbed84ff7465c0bd0310a3eec20c68046322fb53)
- [Pinned sign-in troubleshooting](https://github.com/skulitom/Anode/blob/cbed84ff7465c0bd0310a3eec20c68046322fb53/docs/TROUBLESHOOTING.md)

## Explicit native sign-in

Ordinary opens keep the viewer hidden and disable credential prompting. If Windows cannot automatically authenticate a child session, an open can fail with WORKSPACE_SIGN_IN_REQUIRED. A native RDP disconnect code 2055 indicates a login failure; it does not establish that the account password is wrong.

Microsoft documents an automatic-sign-in exception when the parent session was already signed in before child sessions were enabled. When that ordering applies, it can explain why an explicit native sign-in is needed; it does not diagnose the machine's credential state. The explicit native sign-in path preserves the user's existing parent session and credential policy.

The computer_session open input can explicitly opt into native UI:

    {
      "operation": "open",
      "request_id": "windows-native-sign-in-1",
      "mode": "isolated",
      "width": 1280,
      "height": 720,
      "interactive_sign_in": true,
      "idle_timeout_ms": 120000,
      "max_duration_ms": 150000,
      "timeout_ms": 120000
    }

The user completes Windows' own credential prompt locally. The provider does not retrieve, save or log a password. A PIN may not work for child-session authentication. The native UI is enabled only for this explicitly requested open; it is not enabled by default or by a probe.

The same lease remains preparing while the user signs in. There is no agent input token during that phase. Once the child host is ready, the provider verifies the parent/child identities, dimensions and PointerGuard, hides the viewer, and acquires a native lease for the original owner. The original idle deadline, hard deadline and authorization limit remain in force. Heartbeats do not extend those deadlines.

A completed handoff is permanent for that lease. Signing into a viewer after its lease has closed does not reactivate the agent. A newly opened workspace will not take over that human-controlled child. Windows may ask for credentials again for a later seat or reconnect.

## Windowless helpers and recovery

Task Scheduler launches WScript, a GUI host. A private VBS wrapper starts PowerShell with SW_HIDE. Anode is a WinExe; its owner uses CreateNoWindow and an explicit startup window state. Only interactive_sign_in requests a visible native viewer/prompt. Task Scheduler's Hidden setting alone is not used as console-window protection.

The native guardian must write a ready receipt and pass a PID/creation-time check before an owner can start. Guardian, owner and broker run outside the ordinary relay taskkill /T ancestry.

Every lease has a private ownership journal and unique Anode channel. A permanent common revocation marker and a local native marker fence later creation and input. Owner creation, native lease acquisition and recovery share an operating-system file lock. A scheduled task starting after close observes the marker and refuses to create a session. Native lease tokens stay in the private journal/receipt and are never relay bearer credentials.

The native lease lasts ten seconds and is renewed by bounded liveness calls. The guardian independently tracks broker identity, heartbeat age and monotonic authorization deadlines. An ordinary heartbeat never extends a fixed expiration.

On close, disconnect, expiry or owner death, the guardian revokes the agent's native input lease, switches the viewer to view-only, and shows the retained viewer on the parent session's current primary screen without activating it. The applications remain in the child session. HWNDs are not moved between sessions, and the viewer is the recovery handoff.

To continue using those applications, the user clicks **Take control** in the viewer's top toolbar. Its status changes from **View only** to **You have control**, and the user's mouse and keyboard can interact with the same retained child session and applications. **Release control** returns the viewer to view-only. This explicit local action does not restore the revoked agent lease or create a new session. If the viewer has disconnected, its **Reconnect** or **Sign in…** action reconnects to the retained session while its applications keep running; Windows may require native sign-in again.

Only a verified failed startup with no child session or child host may be dismissed automatically. That path calls quit only on the exact owned --keep Anode process. A successful workspace is never logged off or killed during recovery. Ambiguous ownership or incomplete input revocation reports cleanup-pending and remains guarded.

## Native validation and user handoff

Build the bundled manual harness with:

    node scripts/build-windows-workspace-tests.mjs

On the target, prepare runs without opening a desktop or native credential dialog:

    node windows-workspace-smoke.cjs prepare

It verifies the pinned runtime, compiles the controlled .NET Framework 4.8 WinForms fixture, writes helper syntax artifacts, and creates a private GUI launcher with a SHA-256 receipt. This can run over Session 0 SSH; actual open still requires the ordinary interactive user.

The prepared GUI launcher is stored under the user's private relay validation directory:

    %USERPROFILE%\.mcp-relay\computer\windows\validation-20261124\validate-isolated-sign-in.vbs

The user can double-click it or run it through wscript. It launches only the explicit open-sign-in validation mode, with no PowerShell or Node console window. No Desktop shortcut or file association is installed.

The one-login validation flow:

1. Open the owned Anode viewer and native Windows credential prompt. The original 120-second lease and 150-second hard bound start at open.
2. After the user authenticates, validate the same child/session identity and hide the viewer.
3. Launch only the controlled test window in that child. Verify a native PNG, Unicode text, a keyboard chord, click delivery and child cursor warps.
4. Place the invisible owned viewer rectangle under the stationary parent pointer. Observe PointerGuard suppression without moving the physical pointer. Compare the parent's foreground window, pointer, clipboard sequence, keyboard layout and screens before/after input.
5. Start an independent read-only recovery observer, then terminate only the validation Node owner to exercise abrupt owner loss.
6. Require native revocation within 15 seconds, a visible view-only handoff viewer, the controlled application still alive in the child, and rejected post-recovery agent input.

The fixture is deliberately left in the handoff viewer. It has no user documents and is safe for the user to close. The observer never logs off the child or kills applications.

The final receipt is child-session-native.json in the private validation directory. It includes a schema version, status, exact harness/runtime/fixture hashes, source image hash, session identities, the original deadlines, physical-session observations and explicit gate booleans. The native gate is passed only when all gates are true. The validation owner terminates itself intentionally, so its nonzero exit alone is not the final test result.

## Acceptance boundary

A quick runtime self-test, hidden-task probe, failed-startup cleanup or rejection of late creation checks a specific prerequisite or failure path. Successful isolated desktop acceptance additionally requires native capture/input, unchanged parent input state, and application-preserving recovery after abrupt owner loss.

Run that full flow on an online supported machine, with the user present when Windows needs native sign-in. The final receipt must match the frozen harness and runtime before the workspace gate is considered passed. Keep deployment evidence in the deployment's private audit record.
