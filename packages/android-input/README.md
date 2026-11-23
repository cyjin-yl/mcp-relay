# Android computer backend and first-party Unicode bridge

The Android backend uses existing su access and Android's own screencap, input, dumpsys, ime, settings, and package manager commands. It does not accept a permission prompt, grant Accessibility access, change su policy, or install another vendor's APK. If su has not been locally approved, Android may show its own authorization prompt; the relay never approves it on the user's behalf.

## Runtime contract

- computer_info is read-only. It reports root access, an actual PNG's dimensions, touch input, focused app component, coordinate calibration, key-combination support, and whether the exact bundled bridge APK is installed.
- computer_setup explicitly installs or updates the bundled first-party APK through pm stdin. The embedded SHA256 is checked before installation and the installed APK is checked afterward. Android's package manager enforces the persistent signing identity; there is no uninstall/downgrade fallback.
- Recognized keyguard or non-interactive power state blocks actions; no automatic unlock/wake gesture is sent. Unrecognized OEM lock metadata is reported as unknown, not as unlocked.
- Only the primary display is currently supported. Coordinates are local screenshot pixels; native coordinates use the measured logical-display ratio. A changed size/rotation is rejected before input.
- Taps, bounded touch drags, scrolling and native keys use input. Hover and secondary mouse buttons are unsupported. Simultaneous keys require native keycombination support; separate keyevents are never presented as a chord.
- Android input text maps through a virtual key map and cannot reliably represent arbitrary Unicode. Text therefore requires our bridge and uses InputConnection.commitText, not input text or a clipboard workaround.

The bridge package is dev.cyjin.mcprelay.input. Its service requires BIND_INPUT_METHOD; its exported receivers require a custom signature permission. AOSP's component permission check admits root, while ordinary apps cannot invoke those receivers. The app requests no network/runtime permissions, reads no surrounding editor text, and stores no text history.

For each text action, the backend saves the selected input method and whether the bridge was enabled. It temporarily enables/selects the bridge, sends only base64 UTF-8 and an unpredictable request ID, verifies an acknowledgement for that exact commit, then restores the previous selection/enabled state. The receiver checks that the editor still belongs to the expected focused package. A newer manual input-method choice is preserved and reported. An unknown acknowledgement is not retried automatically.

All root action commands have an Android-side timeout. A Termux su-client exit alone does not prove a privileged child stopped; the backend retains its operation until the bounded root window and cleanup interval have elapsed. Cancellation/unknown outcomes carry mayHaveApplied. Touch cleanup is scoped to this gesture. Native input has no separate key-up-only command; the implementation does not replay a keyevent to pretend it released a key.

## Build and signing

Build only in CT102's dedicated relay-cua-build-20261123 container:

~~~sh
sudo -n /usr/sbin/pct exec 102 -- docker exec -w /workspace relay-cua-build-20261123 \
  python3 packages/android-input/build.py
~~~

The initial signing identity was created with the explicit --create-signing-key option. It lives under /root/.local/share/relay-cua-signing inside the private container home (directory 0700, key/password 0600); deployment operations also retain a private named-volume backup. Never copy signing secrets into the shared worktree or logs. Reuse this identity for all bridge upgrades.

Build requirements: JDK 17, /opt/android-sdk/platforms/android-35/android.jar, and build-tools/35.0.0. The build uses aapt2, javac, d8, zipalign, and apksigner, with no third-party APK or Gradle dependency. Minimum Android API is 23. Each build retains a new output directory and receipt under .tmp/android-input-build; it does not delete old files. The previous generated TypeScript module is archived there before replacement.

A verified signed APK is embedded as base64 and SHA256 in packages/device/src/computer/android-bridge.generated.ts. The regular standalone device bundle therefore includes everything needed for explicit setup and can carry bridge updates via the existing OTA channel.

## Validation status and real-device acceptance

19 backend unit tests run in the development container:

~~~sh
sudo -n /usr/sbin/pct exec 102 -- docker exec -w /workspace relay-cua-build-20261123 \
  npx vitest run packages/device/test/computer-android.test.ts
~~~

They cover geometry/rotation, setup-only installation, Unicode/base64 isolation, exact acknowledgements, no automatic replay, cancellation cleanup, screenshot scaling and unsupported-action reporting. These are controlled tests, not proof of Android hardware behavior.

The real-device harness is packages/device/manual/android-computer-smoke.ts. Bundle it in the development container with esbuild for node/cjs, then transfer the resulting standalone file to the authorized Android device. Run it only after the device is online and deployment coordination permits the explicit setup:

~~~sh
node android-computer-smoke.cjs --setup --out "$HOME/.mcp-relay/computer-test-YYYYMMDD-HHMMSS"
~~~

The output directory must be new. The harness opens only the package's own ProbeActivity, checks screenshot pixels, taps its counter, drags its pad, scrolls its list, inputs benign Chinese/emoji/newline text and verifies its hash, tests Backspace, and verifies the original IME state afterward. It saves two screenshots of that owned UI plus a JSON receipt, and closes the probe only if it still owns focus. It does not operate user chats or payment screens. Private screenshots/receipts stay on the device; no file is deleted.

At the initial implementation checkpoint Android was offline: the APK was built and signature-verified, but hardware acceptance was still pending. A successful unit test or signed APK must not be reported as a real-device pass.

## Primary references

- Android input-method guide: https://developer.android.com/develop/ui/views/touch-and-input/creating-input-method
- InputConnection.commitText contract: https://developer.android.com/reference/android/view/inputmethod/InputConnection
- Receiver permissions: https://developer.android.com/guide/topics/manifest/receiver-element
- Signature permission rules: https://developer.android.com/guide/topics/manifest/permission-element
- AOSP input shell implementation: https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/input/InputShellCommand.java
- AOSP root/component permission check: https://android.googlesource.com/platform/frameworks/base/+/3f4c8d21e239a318549079f92cd1124701273d57/core/java/android/app/ActivityManager.java
- AOSP ordered am broadcast acknowledgement: https://android.googlesource.com/platform/frameworks/base/+/a42e14ce6379/services/core/java/com/android/server/am/ActivityManagerShellCommand.java
