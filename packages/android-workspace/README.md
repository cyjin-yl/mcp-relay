# Android private workspace helper

This is the root-owned Android 14+ virtual-display backend for the computer workspace provider. It is separate from the physical-display backend and from the global Android input-method bridge.

## Boundary

A workspace requires `su`, Android API 34+, and the platform's trusted independent-focus APIs. Creation verifies `TRUSTED`, `OWN_FOCUS`, `STEAL_TOP_FOCUS_DISABLED`, and the actual display removal policy `REMOVE_MODE_MOVE_CONTENT_TO_PRIMARY`. It never requests `DESTROY_CONTENT_ON_REMOVAL` or `ALWAYS_UNLOCKED`.

Keyboard/touch events carry the owned display ID. Capture uses an ImageReader surface owned by that display. The display's IME policy is `HIDE`; the helper never selects/enables an IME or invokes a clipboard service. It rejects clipboard/global/IME keyboard shortcuts. Text is limited to characters the virtual keyboard can map from ASCII; capabilities report `unicodeText: false`.

This isolates display focus and injected input. It is **not an Android application security sandbox**: third-party applications still share their Android user's clipboard, storage, login state and other app resources. Capabilities report `clipboardBoundary: "shared-app-state"`.

Initial launch accepts an explicit `package/Activity` component and no additional intent arguments. An application with an existing task on another display is refused, avoiding single-instance reuse that could move the user's current app. Adopting existing tasks is unsupported. Android may recreate an Activity while its task moves between displays; preserving arbitrary unsaved application state remains the application's lifecycle responsibility.

## Owner and recovery

The broker first persists a resource intent. The provider then starts a single fixed-class `app_process` helper with the lease ID and random instance ID in its command line. The private receipt records the display's unique ID, native PID and `/proc` start ticks.

The helper independently enforces:

- a monotonic lease deadline and an immutable hard deadline;
- a 15-second owner heartbeat deadline;
- stdin EOF;
- the permanent `revoked.json` fence in its private lease directory.

The reader handles renew/close independently of the bounded serial action worker, so a long gesture cannot block its heartbeat. A heartbeat with unchanged public expiry does not extend the provider's monotonic deadline when the wall clock changes.

Cleanup revokes input, releases its pressed keys/touch, lets an already-started launch settle, moves root tasks from its own display to display 0, releases its virtual display, and verifies disappearance. It never enumerates tasks to move from another display. `--recover` verifies PID, start time, command class, lease and instance before writing the fence or signaling that owner. An unrelated receipt cannot target another helper. Signaling is only an emergency fallback; Android `app_process` does not reliably execute Java shutdown hooks on SIGTERM. Binder death plus the verified move-content removal policy provides the final fallback.

The permanent fence is checked before display creation, every input and renewal, and by the independent watchdog. Closing a broker cannot resurrect a display through a late creation result. Native window transactions are synchronized before injection; application launch reporting alone does not establish InputDispatcher readiness.

## Setup and build

`computer_setup` with `workspace: true` deploys the hash-verified bundled dex JAR and probes the APIs. It does not install an APK, drivers, OS packages or an input method. Probe/open require explicit setup if this JAR is absent.

Build **inside a disposable Docker container**, with JDK 17, Android SDK platform 35, and build-tools 35.0.0:

```sh
python3 packages/android-workspace/build.py
```

The build emits a versioned artifact directory under `.tmp/android-workspace-build/` and updates `packages/device/src/computer/android-workspace.generated.ts`. Prior outputs are retained. The generated TypeScript embeds the exact JAR and SHA-256; no on-device compiler or SDK is required.

The optional test APK is a separate, clearly named package, `dev.cyjin.mcprelay.workspaceprobe`. It records only its own text and input events and does not read clipboard/IME contents:

```sh
python3 packages/android-workspace/build.py --probe
npx vitest run packages/device/test/workspace-android.test.ts
node scripts/build-android-workspace-tests.mjs
```

The optional APK uses a disposable test-only signing key; it is never embedded in the device bundle. Reusing a previous APK installation requires its same test key, or uninstalling **only this probe package** before installing the rebuilt probe.

## Native acceptance

On an authorized test device with the probe APK installed, run:

```sh
node scripts/test-android-workspace.mjs /absolute/path/to/relay-android-workspace.jar
node release/android-workspace-provider-smoke.cjs
```

The protocol smoke has nine cases: pre-existing revocation fence, EOF, lease expiry, owner recovery with foreign-receipt refusal, Node owner death during a gesture, helper death during a gesture, active fence, heartbeat loss, and hard deadline. Each active case launches only the dedicated probe, verifies its own text/touch and 640×480 screenshot, compares foreground-display/IME metadata, verifies the same task and text return to display 0, and verifies the owned display disappears. It force-stops only the probe package between cases. Supply case names after the JAR path to run a subset.

The standalone provider smoke tests explicit setup, the real TypeScript open/inspect/capture/action/renew interface, application identity checks, Unicode refusal, fence cleanup, and idempotent recovery. The fixture directories retain JSON receipts and private-display PNGs under `.mcp-relay/workspace-smoke/` and `.mcp-relay/workspace-provider-smoke/`. No physical-display screenshots, user input fields or clipboard contents are collected.

The public broker, authenticated transport disconnect and frame binding are tested separately by the common workspace layer. These native cases do not claim a server-to-device disconnect test.
