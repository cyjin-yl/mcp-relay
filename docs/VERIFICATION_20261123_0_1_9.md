# Verification: device 0.1.9

This record separates tested source, frozen artifacts, native acceptance, publication,
and installation on existing devices. All timestamps below are UTC.

## Source and artifact provenance

[PR #6][pr6] merged as `6949e56458c441af120f8c2767da5ad94f7a4cbb`.
The merge tree is `44f5ce2ba03dfe13d521cdd845fd57b4d949c3fb`, identical to the
final tested source tree. The release includes PVE VM control, the latest native
Windows/macOS fixes, the shell working-directory correction, and temporary shares.

| Stage | Commit |
| --- | --- |
| Source used to build the frozen CLI | `305f499ee3d1ac63cf20d7e30e978744a228ebce` |
| Corrected packaged-client verification gate | `4eab14086ff86ad7d47aeea4478e77cb8752b3fe` |
| Final candidate pin and native workflow | `3093ef4e841c381f7c350543cec8fbedae29bce0` |
| Merged release source | `6949e56458c441af120f8c2767da5ad94f7a4cbb` |

The packaged gate previously expected 0.1.7; it now reads the declared package
version. That test correction did not change runtime code or rebuild the CLI.
From the build commit to the final pin, only that test, the candidate JSON, and the
native workflow changed. Both manual harness sources and runtime inputs remained equal.

The authorized build used an isolated detached worktree, nice level 10 and at most
two test workers. The recorded build/PVE runtime was Node 26.13.0; native CI used
Node 24.22.3. No production relay process was restarted to perform these checks.

| Frozen artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| [Standalone CLI][cli] | 1,421,378 | `cfc010a6ff2ecdd3cd3b4ff2b61bcd1e2842844b6e3ff7cfbcae4f3c964fc921` |
| [Windows/macOS harness][native-harness] | 181,931 | `21070649579ef4d16ac6ce3099f879e55e7c175b006926bd53ea7893df068a5b` |
| [PVE harness used for owned-VM acceptance][pve-harness] | 150,031 | `2d7c387ecbf6ce9d5fdd567048fd54686c2e0dba8ae6db1088fa392fd466d07e` |

The [digest-addressed candidate CLI][candidate-cli] and the published versioned CLI
contain the same bytes. The CLI manifest uses HTTPS and SHA-256, not a separate
manifest signature. The existing signed Android bridge was preserved.

## Final source CI

[Source run 45266588926][source-ci], job `138015007212`, passed on the final pin.
Its PR merge checkout `cf9d88c8cfe8b16cbb77240d609b63264a822a00` has the same
`44f5ce2b…` tree as both the tested head and the actual merge above.

| Check | Verified result |
| --- | --- |
| TypeScript build and Node suite | 25 files, **196 tests passed**, including **19 PVE tests** |
| Complete Go suite | `go test ./... -count=1` passed; application package 5.411s |
| Share authorization races | `go test -race ./internal/app -run '^TestShare' -count=1` passed; 5.105s |
| Production console | Build and lint passed; 0 errors, 3 existing generated-code unused-variable/parameter warnings |
| Real Chromium | **9/9 checks**, 3 screenshots, 0 page errors; Chromium 159.0.8154.6 |

The matching Go source declares 33 top-level Test functions, including 14 TestShare
functions. These are source counts: the non-verbose Go log reports package success,
not individual case events. The command package has no tests.

The browser harness used a disposable Go API/SQLite owner and real device WebSockets.
It verified fixed one-hour shares with online/offline device selection, one-time
claim and document download, three allowed device dispatches, excluded-device denial,
revocation of an initialized token, ahead-of-server clock behavior in both pending
and claimed states, and a 390px mobile viewport without page-level horizontal overflow.

The browser artifact ZIP was verified against GitHub's digest:
`1f8504605152a9bc5dc07ad15674188c3ece4f8c7fa749bf03ca39e2d3d383c3`.

## Final Windows/macOS native matrix

[Native run 45266571015][native-ci] downloaded the exact frozen CLI and harness.
Each downloaded ZIP and its contained binaries were independently hashed; receipt
run ID/attempt, platform, runtime selection and `deviceVersion: 0.1.9` were checked.

| Platform | Actual runtime | Cases | Result |
| --- | --- | ---: | --- |
| macOS 15 | Quartz/JXA; capture/accessibility/input permissions granted | 9/9 | `passed`, `uiVerified: true` |
| Windows / PowerShell 5.1 | 5.1.26100.33822, Desktop edition | 11/11 | `passed`, `uiVerified: true` |
| Windows / PowerShell 7 | 7.6.10, Core edition | 11/11 | `passed`, `uiVerified: true` |

All **31 cases passed**; no platform used the permission-blocked outcome. Checks
covered native PNG dimensions, pixel coordinates, pointer movement, Unicode text,
shortcuts, button clicks, drag/release, wheel input and post-cancellation recovery.
Windows also verified the actual worker PowerShell executable and minimal shell tool.
Cancelled-drag cleanup observations were 142ms, 465ms and 1266ms respectively.
All owned native fixtures exited successfully and ended with no drag held.

## Real PVE VM acceptance

The same frozen CLI passed **10/10** checks through its actual WebSocket transport
against an owned diskless QEMU fixture with USB keyboard and absolute tablet input.
The guest reported `QEMU QEMU USB Keyboard`; the captured display was 1280 × 800.
Acceptance ran from **21:05:48.333 to 21:06:07.591**, approximately **19 seconds**.

1. The standalone CLI advertises target-aware PVE computer tools.
2. Real guest PNG dimensions and VM/console instance identity are bound to the frame.
3. Screenshot-pixel movement arrives as USB tablet coordinates.
4. A click arrives once; duplicate request IDs do not replay input.
5. Repeated printable ASCII, uppercase and punctuation reach the guest without Enter.
6. Key chords and Backspace reach the USB keyboard.
7. Up/down scrolling produces real guest wheel events.
8. Drag produces button-down, final movement and release.
9. Cancellation releases the button and permits fresh input.
10. Out-of-frame coordinates, horizontal scrolling and Unicode fail before guest input.

The guest serial receipt matched all 186 test characters exactly. Final key-down
and key-up counts both reached 268; click and release counts both reached 3.
The vertical wheel total was -1 after the down/up checks, with horizontal total 0.
The displayed preview showed the first 60 characters; the serial assertion checked
the entire string.

The fixture was subsequently removed in a separate cleanup operation. Its receipt
confirms `removed: true` and `existing_vms_unchanged: true`; all six existing VM states and
process identities matched before/after. The approximately 19 seconds above is the
acceptance duration, not cleanup duration. No production VM names or process IDs
are published in this record.

PVE controls the first addressable QEMU graphical console, not a GPU-passthrough
physical screen. Text is printable ASCII with a US guest layout; `unicodeText` is
false. Scrolling supports up/down; left/right return `unsupported_action`.
Device shares select the PVE host, covering its enabled VM consoles, including
future VMs; they do not implement a VM-subset restriction.

## Publication and existing devices

The HTTPS channel was published at **2026-11-23 21:13:51.707029 UTC**.
Public Node read-back completed at **21:13:54.852 UTC**. All three requests below
returned HTTP 200 with `Cache-Control: no-store`; the CLI reported **0.1.9**.

| Public object | Bytes | Verified SHA-256 |
| --- | ---: | --- |
| [0.1.9 CLI][cli] | 1,421,378 | `cfc010a6ff2ecdd3cd3b4ff2b61bcd1e2842844b6e3ff7cfbcae4f3c964fc921` |
| [CLI checksum sidecar][sidecar] | 74 | `bacfead5cb4070f31d1066d97a39c4f4ecc47c53118625540b9fb31792880b1b` |
| [Stable manifest][stable] | 222 | `e0f2a877cf267f2f92d972130156b1849e62335fc63fb948c2a73e78efd548a3` |

Previous stable was 0.1.8, manifest SHA-256
`5b05a6dc1730ade25be392f7f2cfd77bb669aa4b7a4fe1766c206741db65c041`.
Its backup is `/var/backups/mcp-relay/device-0.1.9-cfc010a6ff2ecdd3`.
The publication receipt records `servicesRestarted: false`, `devicesSignalled: false`.
This publishes the HTTPS update channel; it does not claim an npm publication.

The server/console source trees remain equal to deployed
`d690f46f924459be11d59b05e32f8ed0529d21a2` from [PR #5][shares-pr]. This device release
requires no server or web restart; their fresh CI acceptance passed as recorded above.

At **21:08 UTC**, doesvm was observed running a **managed 0.1.7 runtime** with a live
persistent kernel. Saved computer settings were enabled and unpaused. This is a
supervised runtime, not the earlier legacy-worker migration state.

After the normal post-publication `update-check`, a fresh callback at
**21:16:33.945170 UTC** confirmed `version=supervisorVersion=0.1.7`, `phase=running`,
and `lastResult={status:"deferred",version:"0.1.9"}` because persistent kernel state
is active. Credential bytes remained unchanged. **0.1.9 has been detected; worker
activation remains deferred** until the caller safely finishes the existing kernel
session. No kernel reset was issued for this release, and no 0.1.9 worker activation
or production PVE-tool registration is claimed from these receipts.

[pr6]: https://github.com/cyjin-yl/mcp-relay/pull/6
[shares-pr]: https://github.com/cyjin-yl/mcp-relay/pull/5
[source-ci]: https://github.com/cyjin-yl/mcp-relay/actions/runs/45266588926
[native-ci]: https://github.com/cyjin-yl/mcp-relay/actions/runs/45266571015
[cli]: https://relay.cyjin.dev/updates/device/0.1.9/cli.cjs
[sidecar]: https://relay.cyjin.dev/updates/device/0.1.9/cli.cjs.sha256
[stable]: https://relay.cyjin.dev/updates/device/stable.json
[candidate-cli]: https://relay.cyjin.dev/updates/device/candidates/cfc010a6ff2ecdd3cd3b4ff2b61bcd1e2842844b6e3ff7cfbcae4f3c964fc921/cli.cjs
[native-harness]: https://relay.cyjin.dev/updates/device/candidates/cfc010a6ff2ecdd3cd3b4ff2b61bcd1e2842844b6e3ff7cfbcae4f3c964fc921/computer-native-smoke-21070649579ef4d16ac6ce3099f879e55e7c175b006926bd53ea7893df068a5b.cjs
[pve-harness]: https://relay.cyjin.dev/updates/device/candidates/cfc010a6ff2ecdd3cd3b4ff2b61bcd1e2842844b6e3ff7cfbcae4f3c964fc921/pve-computer-smoke-2d7c387ecbf6ce9d5fdd567048fd54686c2e0dba8ae6db1088fa392fd466d07e.cjs
