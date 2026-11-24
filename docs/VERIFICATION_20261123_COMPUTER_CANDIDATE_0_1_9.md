# Verification: unpublished computer-use candidate 0.1.9

Candidate 9d25 for the initially proposed 0.1.9 fixes a setup error-contract defect found during the physical Android rollout of 0.1.8. This report distinguishes source tests, native acceptance, public release, and actual device state. The 0.1.8 artifacts and original evidence remain immutable; see [the initial release report](VERIFICATION_20261123_0_1_8.md).

Review: https://github.com/cyjin-yl/mcp-relay/pull/4

## Confirmed defect and correction

The computer pack supplied its action-attempt flag after backend error details. A setup operation could therefore report `mayHaveApplied=false` even when the backend knew installation had been attempted. A later read-only verification failure could also lose the fact that an installation had already occurred.

The patch conservatively preserves the backend's mutation uncertainty. Android setup now identifies `preflight`, `install`, or `verification`; post-install verification failures remain uncertain, while a proven cancellation before native execution remains unapplied. Installation diagnostics expose only bounded `INSTALL_FAILED_*` / `INSTALL_PARSE_FAILED_*` codes or a small set of static categories. Raw native stdout/stderr, paths, and input are not returned. Action request caching, cancellation cleanup, and old-frame invalidation are preserved.

These changes correct the error contract. They do not turn the original native exit 255 into a successful installation.

## Exact artifacts and full gate

| Artifact | SHA-256 | Bytes |
| --- | --- | ---: |
| Standalone CLI 0.1.9 | `9d25e7fd4ec5f1e6745f90c1e86d9e4e8d460a2bb576fd2d1d91ff424db80663` | 1,378,104 |
| Desktop native harness | `21070649579ef4d16ac6ce3099f879e55e7c175b006926bd53ea7893df068a5b` | 181,931 |
| Android native harness | `5e5057524f02d70e76fa01fbdf539c0d6cf42e1105f59319581f476b5aa6d4ed` | 84,696 |
| Embedded signed Android input bridge | `3159ff9b0e654b4c0d5fbea4cdc9ac568f4ed136c114f0171c8760f030432636` | 25,049 |

The CT102 full gate ran from 21:10:58 to 21:12:01 UTC on 2026-11-23. Typecheck, all three fresh builds, three syntax checks, and **179 automated tests in 22 files** passed. The test run took 55.03 seconds. The desktop harness was rebuilt and produced the same bytes as the accepted 0.1.8 harness.

The gate captured **66 source/test/workflow/configuration inputs** before and after; the captured maps were identical. This historical collection did not include the root TypeScript/Vitest configurations; the later 0.1.10 gate includes those and the added C/Python fixtures. This release explicitly includes `packages/device/manual/android-computer-smoke.ts` in that input collection. Every captured input was checked against the maps again before candidate upload and before the source commit.

- Full-gate receipt: `.tmp/computer-final-0.1.9-v1-artifacts.json`, SHA `7ab5fb19052d0ee7658ac26b6cbddb73205db071883600ee8d932a4289e0dda6`.
- Raw log, exit, before and after files share prefix `.tmp/computer-release-gate-0.1.9-v1`.
- Earlier targeted typecheck and 46 tests passed. Receipt: `.tmp/setup-patch-targeted.json`, SHA `c79af90c114e47b67a9fde536f1774d273e7307f4e4a95cbbabe6cec4fbd49d9`.
- Root reviewed the actual source diff and the original targeted/full receipts. Source review: `.tmp/release-promotion-0.1.9/root-source-review.json`, SHA `6798f99b259662b215fa9562b4a636ff541a354a16c38b500548075223de180d`.
- Source and candidate configuration commit: `ded29ebef1613d1c010e2dc07038cb4f4d5c8066`.

The unchanged updater tests retain real-worker drain, readiness, rollback, persistent-kernel deferral, supervisor handoff, and feature-reload coverage. This full run also retains the real-WebSocket image transport tests.

## Immutable candidate and native CI

The candidate files were uploaded under the complete CLI digest. At 21:13:50.054 UTC, an independent CT102 Node verifier fetched all three public URLs. Each returned HTTP 200, no-store, and the exact expected bytes and SHA-256.

Public receipt: `.tmp/release-promotion-0.1.9/candidate-v1-public-receipt.json`, SHA `f11b6621b0ce2f79da63e0294df3d43e98a56d1560dd2397e6011393751398a1`.

The candidate upload left the published 0.1.8 stable manifest unchanged, SHA `5b05a6dc1730ade25be392f7f2cfd77bb669aa4b7a4fe1766c206741db65c041`.

<!-- NATIVE-STATUS-START -->
Native run [45267679272](https://github.com/cyjin-yl/mcp-relay/actions/runs/45267679272), attempt 1, used source commit `ded29ebef1613d1c010e2dc07038cb4f4d5c8066`. All three roles executed the exact final prebuilt CLI and desktop harness.

| Runtime | Actual UI cases | Result |
| --- | ---: | --- |
| Windows PowerShell 5.1.26100.33822 Desktop | 11 / 11 | Passed, system powershell.exe, worker module-cache override absent |
| PowerShell 7.6.10 Core | 11 / 11 | Passed, actual pwsh.exe |
| macOS 15 | 9 / 9 | Passed, uiVerified=true |

All **31 native cases passed**, without a blocked/skipped substitute. The actual owned fixture text became `replaced ✓`; click, drag, scroll, foreground and cancellation cleanup checks passed. Owned fixture processes then exited cleanly. The raw acceptance and download-provenance files match on version, complete digests, run and attempt. Root independently read those records and verified that their original bytes match the snapshots embedded in the release plan.

Native verification: `.tmp/native-ci-45267679272/verification.json`, SHA `213e71f4ebcacddbe1147287aced5d0cffd05de2173b897704bbe84b7cdb2003`. The six original JSON files remain in that run directory. Prior Linux Xvfb source-level UI evidence is preserved in the initial release report and is not counted as another final-artifact CI run.
<!-- NATIVE-STATUS-END -->

## Stable publication

<!-- PUBLICATION-STATUS-START -->
**This candidate was not published.** Its exact approved plan stopped during the read-only production preflight because stable had already changed to a concurrent 0.1.9 release: manifest `e0f2a877cf267f2f92d972130156b1849e62335fc63fb948c2a73e78efd548a3`, CLI `cfc010a6ff2ecdd3cd3b4ff2b61bcd1e2842844b6e3ff7cfbcae4f3c964fc921` (1,421,378 bytes). That immutable release is preserved. The failed preflight did not execute promotion, rollback, worker signals or service restarts.

The candidate approved plan was `.tmp/release-promotion-0.1.9/plan-approved-9d25-h210706-native45267679272.json`, SHA `ff1984fd18cd0702d568e8447e0a0f5e31919a54d38b721fa6d4835d09bb3cec`; it is stopped and must not be reused by merely changing its old-pointer guard. The diagnostic receipt is `.tmp/release-promotion-0.1.9/preflight-ff1984-diagnostic.json`, SHA `5282133c8f7de2bf5de2cebc061ae12a18292ae2c0a8586001421fd469fe93b8`.

Concurrent artifact provenance and source compatibility were subsequently reconciled; the merged follow-up is documented in [the 0.1.10 verification report](VERIFICATION_20261123_0_1_10.md). This candidate remains unpublished. Go `64439d3e6a0c02bbbd8f380a3df83dc8f10b14c51054c7f0983baa3f2423ddfc` and Caddy `a7b13d09bb33a3d3c8af52403e09d49e1a5a55b44472302c1e95be83c98a017d` remain unchanged.
<!-- PUBLICATION-STATUS-END -->

## Actual devices and automatic follow-up

<!-- DEVICE-STATUS-START -->
| Device | Actual evidence | Remaining work |
| --- | --- | --- |
| Android localhost-0a22 | Actual managed 0.1.8 callback; all five tools; enable and reload completed; legacy cached entry repaired; su and unlocked screen confirmed | One new, verified 0.1.9 candidate setup to diagnose the native installation error, followed by owned UI and real MCP image/action acceptance if available |
| Android localhost-8736 | Independent OnePlus PKX110, Android SDK 36, different boot digest and UID; actual legacy 0.1.6 npx callback | Independent supervised migration and computer acceptance after final stable publication |
| TB14P-EZRA | Offline in the latest device listing; old 0.1.8 conditional invocation armed but not installed | Activate the separately prepared 0.1.9 invocation only after publication, then reconcile old journals and require fresh same-laptop installer/OTA proof |
| doesvm | Actual managed 0.1.7; persistent-kernel update deferral | Preserve the kernel; allow the existing supervisor to advance when safe, then verify tool registration and report the actual headless capability |
<!-- DEVICE-STATUS-END -->

The existing deployment automation is retained. It reconciles unknown transaction outcomes, exact live process identities, and saved request IDs before continuing. A prepared invocation, disk journal, or a queued reload is not successful device installation. Normal device OTA remains enabled independently of this follow-up task.

The computer pack continues to provide info, native PNG screenshots, actions, handoff, and explicit setup. Windows needs an interactive desktop; macOS currently supports the primary display with existing grants; Linux supports X11; Android needs an already authorized su channel and the bridge for Unicode text. Local pause/disable preferences are preserved. OS permissions and locked/secure desktops are reported rather than changed.

The release channel is HTTPS; npm publication is not claimed. See [capability documentation](computer-use.md) and [deployment runbook](../deploy/computer/runbook.md).
