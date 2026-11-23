# Android/Termux one-time relay migration

These finite scripts migrate the existing single-pane tmux `relay` launcher from an older standalone/npm installation to the verified online update launcher. They preserve the original device config and the Termux/Android environment. Future ordinary releases should use `update-check` or the automatic supervisor; do not repeat a legacy migration on an already managed worker.

The scripts apply to the existing `~/.mcp-relay/run-tablet.sh` loop and its single tmux pane. They do not discover arbitrary services or stop processes by their command name. A different launcher topology requires a separate review.

## Files and ownership

| File | Purpose |
| --- | --- |
| `prepare.cjs` | Verify the old PID/start ticks/executable/argv/config, back up the launcher, save a private environment snapshot and generate a private transaction plan; leaves the active relay running |
| `schedule.cjs` | Review the plan by default; `--execute` writes a scheduling receipt and launches one detached finite transaction after a 20-second delay |
| `cutover.cjs` | Verify the public release and immutable inputs, stop the precise legacy loop/worker, start the bootstrap and verify worker/supervisor OTA; restore the old launcher on failure |
| `preserved-env-runner.cjs` | Run the existing shell launcher inside the new tmux pane with the saved original environment and fresh tmux session variables |

Development checks belong in the development container. On the target, execute only the reviewed scripts and prebuilt release artifacts. Use the existing trusted transfer path and verify hashes after transferring. Keep source/versioned artifacts immutable.

## Preparation

Inspect the actual relay process tree and original script before choosing values. Record each PID together with `/proc/<pid>/stat` field 22 (start ticks), its real `/proc/<pid>/exe`, argv, config and the tmux pane owner. Linux/Android Node processes may have names such as `MainThread`; a `comm == node` test does not establish ownership.

The bootstrap must be a verified preceding version, while the stable manifest must already point to the intended final CLI SHA-256. The updated launcher should change the entry to `~/.local/share/mcp-relay/launcher.cjs` and add the approved HTTPS manifest/300-second interval while preserving the existing Termux/Android recovery environment. Review the original-to-updated script diff and hash both files.

Keep the older package/runtime directory in place for rollback. The preparer records its entry digest; it does not delete or modify the package. The target must already have the Node, Bash and tmux executables used by the current launcher. The scripts do not install packages, elevate permissions or change network configuration.

From the directory containing these four reviewed scripts, invoke the preparer with values obtained from that inspection:

```sh
node prepare.cjs \
  --root "$RELAY_DEVICE_ROOT" --stage "$RELAY_OTA_STAGE" \
  --old-launcher-pid "$RELAY_OLD_LAUNCHER_PID" \
  --old-launcher-start "$RELAY_OLD_LAUNCHER_START" \
  --old-worker-pid "$RELAY_OLD_WORKER_PID" \
  --old-worker-start "$RELAY_OLD_WORKER_START" \
  --expected-legacy-entry "$RELAY_OLD_ENTRY" \
  --expected-device-id "$RELAY_EXPECTED_DEVICE_ID" \
  --original-script-sha256 "$RELAY_ORIGINAL_SCRIPT_SHA256" \
  --updated-script "$RELAY_UPDATED_SCRIPT" \
  --updated-script-sha256 "$RELAY_UPDATED_SCRIPT_SHA256" \
  --bootstrap "$RELAY_BOOTSTRAP" \
  --bootstrap-sha256 "$RELAY_BOOTSTRAP_SHA256" \
  --target-version "$RELAY_TARGET_VERSION" \
  --target-sha256 "$RELAY_TARGET_SHA256"
```

`--relay-url`, `--manifest-url` and `--session` can be supplied explicitly; the defaults are the existing project origin, its `/updates/device/stable.json`, and `relay`. Expected device values must come from the deployment record. Do not replace checks with whatever identity a new connection happens to report.

The preparer writes a new mode-0700 transaction directory and mode-0600 plan/environment/receipt files. The full old environment and argv remain private on the target; do not copy them to Git or public evidence. Output contains only paths, hashes and process identifiers. Existing backups must match their expected hash; a conflicting file is a stop condition.

## Scheduling and switch

First review the proposed plan without scheduling:

```sh
node schedule.cjs "$RELAY_PRIVATE_PLAN"
```

After the deployment is authorized and other operators are avoiding that device during the switch:

```sh
node schedule.cjs "$RELAY_PRIVATE_PLAN" --execute
```

The response gives an exact `notBefore` UTC time, detached job PID and receipt path. The job has its own process session and file-backed output, so it can finish or recover while the relay connection briefly disconnects. It requires a durable scheduling receipt identifying its exact PID before it acts. It is a finite deployment transaction, not an AI agent or a polling daemon.

The transaction checks all immutable inputs and the original PID/start ticks/argv again. It downloads the actual public stable manifest and CLI over the approved HTTPS origin and checks the expected final digest. Before stopping anything, it checks for active child work under the old worker; such work produces a deferred receipt. It then stops only the verified launcher loop and legacy worker with `SIGTERM`, waits for their real exits and the old tmux pane to disappear, and replaces the launcher atomically from the preserved copy.

The new session retains the same tmux session name and shell script path. The environment runner restores the saved Termux/Android values, while using the new pane's tmux/terminal context and resetting only internal relay role flags. The updated launcher starts the verified bootstrap, whose real supervisor fetches and installs the stable release.

Success requires `update-status` to report `running`, the expected worker and supervisor versions, the final SHA-256 and the bootstrap as `previousVersion`. The job verifies the real worker entry bytes, original config digest and preserved runtime environment. Its successful phase is `active-awaiting-external-tool`; it does not claim an external tool call happened merely because the worker is connected.

## External acceptance

Wait for the device to reconnect, then invoke a real My Devices `bash` tool and inspect the status:

```sh
node "$HOME/.local/share/mcp-relay/launcher.cjs" update-status \
  --config "$HOME/.mcp-relay/device.json"
```

Confirm `process.platform` is `android`, the configured working directory is unchanged, and the actual Bash child environment contains `PREFIX`, `HOME`, `ANDROID_DATA`, `ANDROID_ROOT`, `ANDROID_RUNTIME_ROOT`, `ANDROID_ART_ROOT`, `ANDROID_I18N_ROOT`, `ANDROID_TZDATA_ROOT`, `BOOTCLASSPATH` and `DEX2OATBOOTCLASSPATH`. Record only key names/presence or comparison results, never private environment values. Also recheck the config SHA-256 and original device identity.

Keep a separate receipt for the successful external call. Retain the transaction's scheduling receipt, final receipt, prior script and logs. The plan/environment contain private values and should stay mode 0600.

## Failure and recovery

A preflight or active-child deferral leaves the original relay running. Inspect the receipt and prepare a new transaction only after the concrete blocker is resolved; do not retry the same scheduling record or bypass PID/start-time validation.

If activation fails after the old worker was stopped, rollback stops only known process generations from this transaction, waits for them to exit, verifies the original config/entry, restores the original launcher and starts its old package again in the same tmux session. It does not overwrite the device config or terminate all Node processes.

Unknown descendants may be user work. They cause rollback to remain pending rather than being killed. If an unknown relay still owns the config, or its known managed processes have not exited, the old worker is not started alongside it. Preserve the journal and report the precise blocker; no generic process kill or unattended elevation is a recovery step.

On 2026-11-23 the Android device completed the real `0.1.7-bootstrap.1` to `0.1.7` worker/supervisor transition, followed by a successful My Devices Bash call. See [the release verification record](../../docs/VERIFICATION_20261123_0_1_7.md) for that deployment's facts. The reusable scripts also keep argv out of public receipts and validate saved environment/legacy-entry digests before acting.
