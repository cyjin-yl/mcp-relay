# Device 0.1.9 release procedure

This procedure covers the standalone HTTPS device channel. Building a bundle,
passing CI, publishing the channel, and observing an upgraded device are separate
steps. Keep the final release receipt and each device's acceptance or deferred
state distinct. This document is preparation, not evidence that 0.1.9 is installed.

## Source baseline

The integration must preserve all of these changes before the final build:

| Source | Required content |
| --- | --- |
| [PR #3](https://github.com/cyjin-yl/mcp-relay/pull/3), including `ea12e27c678d4dcacbb88ff61b58c3708d890796` | Transactional device updates and the follow-up binding shell discovery to the validated working directory. The latter commit was not an ancestor of the PR #4 head below. |
| [PR #4](https://github.com/cyjin-yl/mcp-relay/pull/4), through `fa2dfdf43346ec69c78bc67a6885c89b784d2e6d` | Native computer control, feature reloads, Windows PowerShell 5.1 compatibility, and the latest macOS modifier-release and fixture fixes. |
| [PR #5](https://github.com/cyjin-yl/mcp-relay/pull/5), through `d690f46f924459be11d59b05e32f8ed0529d21a2` | One-time temporary device sharing, server-enforced expiry/revocation, and the console clock-skew correction. These server/console changes have their own deployment lifecycle. |
| 0.1.9 integration changes | The Proxmox VM computer backend, its target routing and acceptance coverage, and the version changes listed below. |

Re-read remote branch heads before the final integration commit. Do not reset an
active source branch to an older snapshot or assume that a stacked PR contains a
later commit added to its base. The completed integration should preserve both
PR #4's native fixes and PR #5's sharing changes.

The earlier native matrix [run 45249888810](https://github.com/cyjin-yl/mcp-relay/actions/runs/45249888810)
is evidence for its pinned 0.1.8 artifact only. The sharing acceptance [run 45247935753](https://github.com/cyjin-yl/mcp-relay/actions/runs/45247935753)
is evidence for the recorded PR #5 head. Re-run applicable checks for the final
integration and bundle; neither run proves 0.1.9 acceptance.

## Versions and build inputs

Set all three device-version fields to `0.1.9`:

- `packages/device/package.json`: `version`.
- `packages/device/src/cli.ts`: `VERSION`.
- Root `package-lock.json`: `packages["packages/device"].version`.

The repository package version, shared package version, wire protocol version, and
Android input bridge version are separate identifiers. A device release does not
require changing them.

Build and test in the existing development container, not on the PVE host:

```sh
npm ci
npm run typecheck
npm test -- --maxWorkers=2
npm run build:publish --workspace @cyjin/mcp-relay
node packages/device/test/packaged-smoke.mjs packages/device/dist/cli.cjs
node packages/device/dist/cli.cjs --version
```

`scripts/build-device.mjs` bundles the CLI and required runtime dependencies into
`packages/device/dist/cli.cjs`, targeting Node 22. It also writes:

- `release/device/0.1.9/cli.cjs`.
- `release/device/0.1.9/cli.cjs.sha256`.
- Local `release/device/stable.json` with `minNodeVersion: "22.5.0"`.

The local `stable.json` is a build output. The build does not publish it. Freeze the
bundle bytes and SHA-256 after all source changes and version updates; any later
change to those bytes requires fresh artifact-specific validation.

## Integrity and native acceptance

The CLI update manifest uses HTTPS, same-origin artifact downloads, and SHA-256.
There is no separate CLI signing-key or manifest-signature field in the current
updater. Syntax/import/version preflight, authenticated registration, and the
stability window are additional activation checks, not cryptographic signatures.

The bundled Android IME is a separate signed APK. If its source is unchanged,
preserve the existing `android-bridge.generated.ts` artifact and signing identity.
If it changes, use `packages/android-input/build.py` in the dedicated development
container with the existing private keystore and password file. Do not generate a
replacement signing key for a routine device release or move signing secrets into
the repository. Record the resulting APK digest separately from the CLI digest.

For the final candidate:

1. Freeze the native harness bytes as well as the standalone CLI. Upload them to
   new immutable paths, usually beneath `/updates/device/candidates/<bundle-sha>/`.
   Check the public bytes with the expected digests before starting CI.
2. Update `.github/computer-native-candidate.json` with the exact new URLs and
   digests only after those artifacts exist. The workflow downloads and executes
   those artifacts; it does not rebuild the source on each platform.
3. Run `.github/workflows/computer-native-smoke.yml` for Windows PowerShell 7,
   Windows PowerShell 5.1, and macOS. Confirm the integration branch matches its
   push trigger, or use an available workflow dispatch with all four artifact
   inputs. A source push alone does not imply that this workflow ran.
4. Inspect `artifact-provenance.json` and `acceptance.json` for the exact CLI and
   harness digests, run ID/attempt, runtime, cases, and `uiVerified`. The workflow
   permits a documented macOS permission blocker to complete successfully; such
   a receipt is `blocked`, not proof of native input. Windows requires a native
   UI pass.
5. Exercise the final PVE backend on an owned VM fixture, including discovery,
   screenshot, input, and target isolation. Record unsupported guest input or
   unavailable VMs accurately. Use only the intended test window for input
   acceptance, and retain existing VM state.
6. Run the server/console checks for the integrated sharing source as well. Device
   artifact acceptance does not replace the server tests or actual browser share
   create/claim/revoke path.

The older Windows shell workflow defaults to 0.1.7 artifacts when no inputs are
provided. Supply the final 0.1.9 CLI/harness URLs and digests if using it; a green
run with its defaults does not validate this release.

## Publish the HTTPS channel

The live stable manifest was read at **2026-11-23 20:18:25 UTC** and returned
HTTP 200 with `Cache-Control: no-store`:

| Observed item | Value |
| --- | --- |
| Version | `0.1.8` |
| Bundle | `https://relay.cyjin.dev/updates/device/0.1.8/cli.cjs` |
| Bundle SHA-256 | `fc83a4f1e9c790c627c10b3752608a2dd6a72e1c6595f310b700698388bbc64c` |
| Exact manifest SHA-256 | `5b05a6dc1730ade25be392f7f2cfd77bb669aa4b7a4fe1766c206741db65c041` |

This is an observed baseline, not permission to replace a later channel update.
Immediately before publication, read the live manifest again, retain its exact
bytes, and compare them to the approved previous state. Coordinate the channel
write so another release cannot be overwritten between that check and promotion.

Publish in this order:

1. Install the already-verified final bytes at the new versioned
   `/updates/device/0.1.9/cli.cjs` path with its SHA-256 sidecar. If that path already
   exists with different bytes, stop and resolve the version collision; never
   overwrite an immutable-cached release.
2. Read back the public artifact and verify its digest, size, syntax, and version.
   Include a Node download check because an edge policy may behave differently
   for Node and curl. Keep previous versioned artifacts available.
3. Atomically replace `stable.json` only after final acceptance. The new manifest
   must point to the final 0.1.9 URL and digest, retain schema version 1 and Node
   minimum 22.5.0, and remain uncached. The existing updates route should need no
   Caddy change; if configuration changes are necessary, validate before reload.
4. Read back the public stable manifest and referenced artifact. Record the source
   commit, artifact digests, previous/current manifest digests, publication time,
   and CI/native receipts. Only then report the HTTPS channel as published.

Restoring the previous manifest can stop further uptake of a bad release; it does
not downgrade devices that already activated a higher version. The updater rejects
downgrades. Device recovery must follow its last-good activation rollback or a
separately reviewed corrective release.

GitHub tags/releases and npm are separate publication surfaces. The existing HTTPS
channel does not depend on either. If they are published too, bind them to the
same final source/artifact and record their outcomes independently; an HTTPS
promotion alone does not change what `npx @cyjin/mcp-relay` installs.

## Device rollout and persistent work

Follow [the computer deployment runbook](../deploy/computer/runbook.md) using the
final 0.1.9 digest. Existing supervisors poll the configured manifest, stage the
candidate, drain accepted work including result delivery, and defer if active work
or persistent kernel state prevents a safe switch. Use `update-check` to request a
check and `update-status` to observe it; do not repeatedly issue feature enablement
or reload commands.

For doesvm's legacy worker, retain the existing migration waiter and its protected
PID/start-time identities. Do not reset its kernel, signal the worker, start a
second worker with the same config, or replace the launch path just to make the
version number advance. Stage/defer is a valid rollout state until the protected
work naturally finishes.

After any device upgrade, require both worker and supervisor version `0.1.9`, the
expected digest, a fresh registered generation, and a real tool callback from that
device. For computer access, additionally inspect live capabilities and perform
the appropriate authorized platform acceptance. Offline, kernel-deferred,
permission-blocked, and installed-but-not-yet-verified devices remain separately
reported until their evidence is complete.
