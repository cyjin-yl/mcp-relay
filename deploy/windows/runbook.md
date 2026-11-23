# Windows deferred relay installation

This runbook performs the one-time migration from a legacy npm relay to the managed standalone launcher. The running launcher subsequently checks the HTTPS release channel and updates its supervisor and worker. Use the already trusted SSH account on the deployment host. The destination address and account belong in the private job configuration, not in this document.

`deploy/windows/deferred-install.py` executes one bounded attempt. It is not a scheduler. Each attempt must have a fixed deadline. A condition watcher may schedule another bounded attempt after temporary unavailability; it stops on success or a blocked/failed result. The script defaults to a plan; `--execute` runs it, and `--mode Install` explicitly permits the previously authorized migration. `--mode Stage --execute` transfers, verifies and tests without changing the active startup entry.

## Frozen release inputs

| Input | SHA-256 | Repository-relative path |
| --- | --- | --- |
| Standalone CLI 0.1.7 | `fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda` | `release/device/0.1.7/cli.cjs` |
| Windows native smoke v2 | `38ae99ff485ef22baeb35f2c31a3482dbe64309b20a1fddc032d598f8a651a61` | `.tmp/windows-bundle-smoke-v2.cjs` |
| Internal preceding bootstrap | `54d2162bc32cfc25278d68ac30cd16cb0612e8adec71b742de8eff7837058a43` | `.tmp/deploy-stage/ready-fc1bf1088fb7/launcher.cjs` |

The public CLI URL is `https://relay.cyjin.dev/updates/device/0.1.7/cli.cjs`. The public smoke URL is `https://relay.cyjin.dev/updates/device/0.1.7/windows-bundle-smoke-v2.cjs`. Keep the internal bootstrap with the reviewed deployment inputs. Do not replace it with the final CLI: the differing preceding version is needed to prove an actual bootstrap-to-stable update.

The v2 harness changes only the test's comparison of Windows long/8.3 aliases with `fs.realpathSync.native`. The production CLI bytes are unchanged. The first harness URL remains immutable; use the v2 hash and URL above. A CI receipt establishes Windows compatibility, but the installer requires a second receipt produced on the destination computer with the exact CLI and harness bytes.

## Before enabling the finite retry job

Confirm the stable manifest has been promoted to the exact CLI digest above and native Windows acceptance has passed. Keep a private job record of the reviewed destination, expected Windows computer and account, hashes and local artifact paths. Run the job as the deployment-host account that already has the verified SSH key and known-host entry. Do not add a host key, change authentication, enable a listener or run an elevation prompt automatically.

The target needs its existing stable Node installation, Windows OpenSSH, the existing device config and a logged-in user session for the current-user interactive scheduled task. The installer checks the config's relay URL and hashes its contents; it never prints the device token or rewrites the credentials. The default Node location is the stable fnm `v24.14.0/installation/node.exe` path under AppData, not a temporary `fnm_multishells` directory. Supply `--node-path` only after independently verifying a different stable location.

Permit at most one attempt per device, with a 720-second deadline for each attempt. The helper also takes a local per-device file lock; the Windows installer takes a cross-session mutex for the canonical config. Stop after the first successful `active` or `already-managed` receipt. A laptop that stays asleep cannot be upgraded; retain the deferred receipt and let the condition watcher retry later without claiming an installation.

## One exact attempt

Set the three private destination variables from the existing trusted deployment record. They must be fixed expectations; do not derive the expected account or computer name from an unverified remote response.

```sh
export RELAY_WINDOWS_SSH='<existing-user>@<existing-trusted-host>'
export RELAY_WINDOWS_COMPUTER='<expected-computer-name>'
export RELAY_WINDOWS_IDENTITY='<expected-computer-name>\<expected-user>'

python3 deploy/windows/deferred-install.py \
  --ssh-target "$RELAY_WINDOWS_SSH" \
  --expected-computer-name "$RELAY_WINDOWS_COMPUTER" \
  --expected-identity "$RELAY_WINDOWS_IDENTITY" \
  --bundle release/device/0.1.7/cli.cjs \
  --bundle-sha256 fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda \
  --bootstrap .tmp/deploy-stage/ready-fc1bf1088fb7/launcher.cjs \
  --bootstrap-sha256 54d2162bc32cfc25278d68ac30cd16cb0612e8adec71b742de8eff7837058a43 \
  --harness .tmp/windows-bundle-smoke-v2.cjs \
  --harness-sha256 38ae99ff485ef22baeb35f2c31a3482dbe64309b20a1fddc032d598f8a651a61 \
  --mode Install --execute
```

Without `--execute`, this prints the ordered plan and does not contact the target. To transfer and run native acceptance without installing, replace `--mode Install` with `--mode Stage`.

The helper passes PowerShell as UTF-16LE `-EncodedCommand`; it passes artifact bytes through SSH stdin as base64, with SHA-256 checked before transfer, before writing, after writing, and again by the PowerShell scripts. It snapshots the repository's two PowerShell scripts in memory and records/transfers their hashes as well. No shell interpolation is used for destination paths, identities or hashes.

## Ordered execution and native commands

The helper first invokes the existing SSH destination with:

```text
ssh -T -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=4
    -oServerAliveInterval=10 -oServerAliveCountMax=2 <existing-user>@<existing-host>
    powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand <encoded-script>
```

Each remote invocation checks both `$env:COMPUTERNAME` and the current Windows identity against the expected values before it acts. Successful strict SSH plus this identity check is the online signal. The first JSON response records only the verified computer/account, stable Node path and a unique staging directory under the user's temporary directory. Authentication or host-key failures stop the attempt. A connection timeout produces a deferred result.

The helper then transfers five files to that unique directory: the CLI, bootstrap, v2 harness, `scripts/test-windows-bundle.ps1` and `scripts/install-windows.ps1`. It does not copy the production device config. It invokes `install-windows.ps1 -Mode Stage` to validate Node, the existing config URL, all three artifact hashes and version order, and to preserve immutable managed staging copies.

The equivalent native PowerShell calls, using values already verified by the SSH job, are:

```powershell
$common = @{
    BundlePath = (Join-Path $verifiedStage 'cli.cjs')
    ExpectedSha256 = 'fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda'
    BootstrapPath = (Join-Path $verifiedStage 'launcher.cjs')
    BootstrapSha256 = '54d2162bc32cfc25278d68ac30cd16cb0612e8adec71b742de8eff7837058a43'
    HarnessPath = (Join-Path $verifiedStage 'windows-bundle-smoke.cjs')
    HarnessSha256 = '38ae99ff485ef22baeb35f2c31a3482dbe64309b20a1fddc032d598f8a651a61'
    NodePath = $verifiedStableNode
    ExpectedComputerName = $expectedComputer
    ExpectedIdentity = $expectedIdentity
    ExpectedRelayUrl = 'https://relay.cyjin.dev'
    ManifestUrl = 'https://relay.cyjin.dev/updates/device/stable.json'
    RequireOtaProof = $true
}
& (Join-Path $verifiedStage 'install-windows.ps1') @common `
    -Mode Stage -ReceiptPath (Join-Path $verifiedStage 'stage-receipt.json')
```

Run the native acceptance in a separate PowerShell invocation, because each script exits with its receipt status:

```powershell
& (Join-Path $verifiedStage 'test-windows-bundle.ps1') `
    -BundlePath (Join-Path $verifiedStage 'cli.cjs') `
    -ExpectedSha256 'fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda' `
    -HarnessPath (Join-Path $verifiedStage 'windows-bundle-smoke.cjs') `
    -HarnessSha256 '38ae99ff485ef22baeb35f2c31a3482dbe64309b20a1fddc032d598f8a651a61' `
    -NodePath $verifiedStableNode -ExpectedComputerName $expectedComputer `
    -ReceiptPath (Join-Path $verifiedStage 'acceptance-receipt.json')
```

This starts only test-owned processes using a synthetic loopback identity. It requires all ten cases to pass, including actual PowerShell, Unicode/cwd/environment behavior, native exit codes, file operations, root isolation, confirmation rules, timeout/cancellation trees, Windows named-pipe exclusion and IPC drain/shutdown. It binds the receipt to the machine, SSH identity and exact artifact hashes. Evidence remains under the receipt's `evidence` directory.

Only after that receipt passes does a new invocation perform the switch:

```powershell
& (Join-Path $verifiedStage 'install-windows.ps1') @common `
    -Mode Install `
    -AcceptanceReceipt (Join-Path $verifiedStage 'acceptance-receipt.json') `
    -ReceiptPath (Join-Path $verifiedStage 'install-receipt.json')
```

`RequireOtaProof` remains true in `$common`. The installer preserves the old task XML, old entry and required `ws` runtime dependency, plus a config hash and recovery journal. It registers the new task disabled before stopping the one verified legacy PID, so a task-registration permission failure leaves the old relay running. It then starts the stable Node launcher and requires the real stable worker and supervisor to appear with the exact release digest and the bootstrap as the preceding version.

The new task runs with the current user's limited interactive identity and starts at that user's logon. It is not a system boot service for a logged-out user. The script never elevates, prompts for credentials, changes execution policy or terminates processes by the generic name `node.exe`. A legacy process from an unknown package path is a stop condition, not a reason to broaden the process selector.

## Readback and successful completion

The helper reads `acceptance-receipt.json` and `install-receipt.json` back through the same strict SSH channel. Its local attempt directory is `.tmp/windows-deployment/<UTC-time>-<random-id>/`. It saves input digests, each step's JSON, both readback receipts and `attempt-receipt.json`, with private permissions. The final stdout contains only a short status and the local receipt path.

A successful Install requires all of:

- `passed: true`, with `phase` equal to `active` or `already-managed`.
- `runtimeSha256` equal to the frozen CLI SHA-256.
- `runtimeVersion` and `supervisorVersion` equal to `0.1.7`.
- `otaProven: true`, proving the preceding bootstrap transitioned to stable.
- The installed receipt's `configSha256` equal to the Stage receipt's hash.
- A successful destination-local acceptance receipt using the frozen v2 harness.

To inspect receipts manually, run only these selected files over the trusted channel:

```powershell
Get-Content -LiteralPath (Join-Path $verifiedStage 'acceptance-receipt.json') -Raw
Get-Content -LiteralPath (Join-Path $verifiedStage 'install-receipt.json') -Raw
& $verifiedStableNode (Join-Path $env:USERPROFILE '.mcp-relay\managed\bootstrap.cjs') `
    update-status --config (Join-Path $env:USERPROFILE '.mcp-relay\device.json')
```

The final online verification should also call a real `powershell` tool through My Devices after the relay reconnects, confirming the original device identity and expected version/tool list. A successful CI run or a local Stage receipt alone does not mean the laptop was upgraded.

## Retry, permissions and rollback

| Helper exit | Meaning | External job action |
| --- | --- | --- |
| `0` | Requested Stage or Install completed and receipts passed | Stop retrying this attempt; mark installed only for Install |
| `75` | Device/SSH temporarily unavailable, an attempt already owns the lock, or a step's remote outcome is uncertain | Schedule another bounded attempt after checking the current state; retain receipts |
| `77` | Existing SSH trust/authentication, execution policy or detected task permission blocked the action | Stop; report the concrete blocker, without elevation or trust changes |
| `1` | Artifact, identity, native acceptance or installation/recovery validation failed | Stop and inspect the preserved evidence before another rollout |

An SSH timeout during Install can leave the remote attempt finishing independently. Do not infer that the old process is still active, start another relay manually or kill all Node processes. The next bounded attempt reuses the Windows config mutex and the installer recovers an unfinished journal before another switch.

On an installation failure, the installer restores the previous task and saved entry after its own managed processes have stopped, checking that the config hash is unchanged. If processes are still active or permissions prevent recovery, it preserves `rollback-pending` and an explicit receipt. It does not overlap the legacy relay with an uncertain running managed worker. Preserve these files for the next reviewed recovery step; no cleanup is needed to retry.

Do not treat the `administrator` boolean as a demand for elevation. Registering a limited current-user task may be permitted without administrator rights. If it is denied, `permissionDenied` and the failure receipt are the result; the job stops.
