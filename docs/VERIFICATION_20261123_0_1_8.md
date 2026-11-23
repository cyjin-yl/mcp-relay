# Verification: computer use 0.1.8

The final client and native harness passed acceptance, and **0.1.8 was published to the stable HTTPS channel on 2026-11-23 at 20:14:55 UTC**. An independent Node download verification completed at 20:15:11 UTC. Physical device installation and native capability acceptance remain separate gates.

Review: https://github.com/cyjin-yl/mcp-relay/pull/4. The feature builds on the Windows/supervised-update work in #3.

## Frozen release artifacts

| Artifact | SHA-256 | Bytes |
| --- | --- | ---: |
| Standalone CLI 0.1.8 | `fc83a4f1e9c790c627c10b3752608a2dd6a72e1c6595f310b700698388bbc64c` | 1,376,361 |
| Desktop native harness | `21070649579ef4d16ac6ce3099f879e55e7c175b006926bd53ea7893df068a5b` | 181,931 |
| Android native harness | `9651ffbac8055d079262143a44e62750cc891b0f05d4105e81004fa15d87ec42` | 83,115 |
| Embedded signed Android input bridge APK | `3159ff9b0e654b4c0d5fbea4cdc9ac568f4ed136c114f0171c8760f030432636` | 25,049 |

The candidate files were independently downloaded with Node over HTTPS and checked for exact length, SHA-256 and no-store headers. Candidate upload alone was never treated as stable publication.

## Completed verification

Development builds and tests ran in CT102. The final production and automated-test inputs passed TypeScript checking, standalone CLI/harness builds and syntax checks, and **164 tests in 22 files**. The v4b test run completed on 2026-11-23 at 19:17 UTC; its raw log, exit code and source snapshots are preserved.

Native CI executed the actual prebuilt CLI and harness, bound to their exact digests:

https://github.com/cyjin-yl/mcp-relay/actions/runs/45249888810

Run `45249888810`, attempt `1`, source commit `fa2dfdf43346ec69c78bc67a6885c89b784d2e6d`:

| Runtime | Actual UI cases | Result |
| --- | ---: | --- |
| Windows PowerShell 5.1.26100.33822 Desktop | 11 / 11 | Passed; actual system powershell.exe; worker cache-path setting absent |
| PowerShell 7.6.10 Core on Windows | 11 / 11 | Passed; actual pwsh.exe |
| macOS 15 | 9 / 9 | Passed; uiVerified=true, not blocked or skipped |

All **31 native cases** passed. The acceptance records and download provenance agree on run, attempt, platform, actual runtime, CLI digest and harness digest. The Mac fixture's text was actually replaced, and click, drag, scrolling and cancellation cleanup were observed. The subsequent input after cancellation also succeeded.

Linux X11 was separately exercised against an isolated Xvfb desktop and an owned Tk window. Its source-level native checks covered a 1024 x 768 PNG, Chinese/emoji, shortcuts, click, drag, scrolling, cancellation cleanup and a fresh screenshot. This earlier source-level test is not presented as another final-artifact native CI receipt.

Android backend tests and signed APK build/signature checks passed. Subsequent physical-device observations confirmed the actual MCP owner on managed 0.1.8. The original unmanaged 0.1.6 duplicate received one guarded SIGTERM and was later independently observed absent. A later npx invocation exited before its conditional retirement transaction; that transaction stopped without a signal or file change. A separate guarded, backed-up repair of only the exact legacy cached CLI completed at 20:37 UTC. The computer pack was enabled once and its managed reload completed; all five tools and real computer_info were verified. The first explicit bridge setup returned exit 255 and the package remained absent. This exposed a setup uncertainty-reporting defect, subsequently addressed in the separate 0.1.9 patch. No owned UI, screenshot or input acceptance is claimed for that failed 0.1.8 setup.

### Exact source association

The v4b build captured **65 complete source/test/workflow/configuration inputs** before and after execution. The maps were identical. Its receipt is:

`.tmp/computer-final-v4b-artifacts.json`

SHA-256: `798cda38d0bb22274acd01b8f3f90f986e883bb8d30c4bf9b457e7df32c75b9e`.

After that run, only two manual acceptance files changed: `computer-native-fixtures.ts` and `computer-native-smoke.ts`. The Windows fixture's reader was made consistent and bounded; the Cocoa fixture received a standard Edit / Select All menu. The final harness build captured new, identical before/after maps and independently verified that the exact source difference comprised only those two files. Production code, automated-test code, CLI bytes and Android harness bytes were unchanged, so the 164-test result was reused. The final native CI then exercised the new harness.

Final source/harness receipt: `.tmp/fixture-menu-artifacts.json`, SHA-256 `87c5579305964b6523b2bc1e8f99edba66f4445b9d0b55a3fc04d4b9271552af`. The two raw source-snapshot files both hash to `eedd569ad052d392f60c698ab0e317602aa63ea66de425a49fd49c9fb08247f3`.

Native verification summary: `.tmp/native-ci-45249888810/verification.json`, SHA-256 `83d480c788400d0bcb9339d3b70ea750089e57ef60f32118468b2918b5dbabe6`. Original per-runtime acceptance and provenance JSON remain beside it.

## Compatibility repairs

Windows PowerShell 5.1 required an explicit import of the trusted system Utility module and direct .NET UTF-8 initialization. An existing module-analysis-cache environment value is preserved when supplied; the native acceptance also proved operation with that value absent. Input and cleanup arrays now use `System.UInt16[]`, which PS5 recognizes. No security or execution policy was changed.

On macOS, five no-input probes isolated a JXA explicit-CFRelease crash. Event creation, CGPoint reading and Unicode setup succeeded; explicit release produced SIGSEGV/SIGBUS. The implementation retains the bounded references within each separate osascript helper until that helper exits. This does not claim a proven GC, ARC or double-free mechanism. Actual key-up and mouse-up cleanup remains mandatory.

Mac shortcuts now issue real modifier down/up events, ordinary key events, and reverse-order release. Flags are recomputed from the remaining owned keys, including left/right keys sharing one modifier mask. Timeout/error cleanup includes those modifiers. Four regression cases execute the actual embedded JXA event algorithm, and the final native acceptance confirms real selection and text replacement.

A native-process error from a child with a PID is no longer mistaken for process exit. Cleanup waits for actual termination before releasing the desktop transaction. Unknown input outcomes are not replayed.

## Supervisor, transport and local control

Five tools are provided: `computer_info`, `computer_screenshot`, `computer_action`, `computer_handoff`, and `computer_setup`. Native PNG image blocks are carried separately from text metadata. Fresh screenshot geometry/foreground, frame expiry, request IDs and a per-user desktop transaction lock constrain input.

Six standalone-CLI checks covered enable, pause preservation, resume, disable, private sidecar permissions and unchanged credential bytes. Twenty-five real-worker supervisor cases covered drain, persistent-kernel deferral, candidate readiness, rollback/recovery, supervisor handoff, same-version feature reload and configuration-revision races. Test timing fixes measured actual drain/manifest phases; they did not change production updater timeouts.

The Go image/scope support was deployed on 2026-11-23 at 16:46 UTC as `b10e470c9e936abfa2a7dc5d8e66909107051ffa16d109daa779d06836cb0b41`. A separate temporary-sharing deployment subsequently replaced it at 19:34 UTC with `64439d3e6a0c02bbbd8f380a3df83dc8f10b14c51054c7f0983baa3f2423ddfc` (11,808,928 bytes, source commit `d690f46f924459be11d59b05e32f8ed0529d21a2`). The actual running executable, disk file and that release's build artifact matched, and health/readiness were 200. Its `computer.go` is byte-for-byte identical to this branch; both MCP call paths retain write-scope enforcement and native image transport. Registered-device WebSocket messages still allow 20 MiB and decoded images 12 MiB; hello and HTTP limits remain 1 MiB. Action/setup/handoff enforce write scope.

The first client-publication preflight correctly stopped because it expected the earlier Go digest. No stable replacement occurred in that attempt. After read-only source, build-artifact and live-process verification, a separate approval pins the compatible sharing build as the new expected server baseline. The existing sharing deployment is preserved; no Go binary is overwritten for this client release.

Client publication uses immutable version files, exact digest/length checks, a release lock, an expected-old-stable comparison, an atomic stable-pointer replacement and independent public verification. Rollback may restore only this transaction's pointer. It does not force worker downgrade or restart. Full source maps and original native JSON bytes are embedded in the approved plan and revalidated locally and remotely.

## Publication and device rollout

**Stable publication is complete and independently verified.** The live stable manifest is version 0.1.8, CLI SHA `fc83a4f1e9c790c627c10b3752608a2dd6a72e1c6595f310b700698388bbc64c`, manifest-file SHA `5b05a6dc1730ade25be392f7f2cfd77bb669aa4b7a4fe1766c206741db65c041`.

The approved plan hashes to `adf8ff0c6a8ba1c0fd62df6c9636401d7ee1c2147127d20c1808aa8397cb255d`. The transaction completed healthy with exit 0 and no rollback; it did not signal workers or restart services. Go `64439d3e...2423ddfc` and the Caddy configuration remained unchanged. The independent CT102 Node verifier fetched the live stable manifest and all three versioned artifacts, obtaining HTTP 200, no-store headers, and the exact expected bytes and SHA-256 values.

- Production receipt: `.tmp/release-promotion/promotion-v2-production-receipt.json`, SHA `0280952a590ecf1ef0d0956a863ac4a57edc45048bcd977c4972216f6204e4fd`.
- Independent public verification: `.tmp/release-promotion/promotion-v2-independent-public.json`, SHA `276008f1635ad91894bb1f7390059f32ce94192ce8447eb97baff4ad85af09ab`.
- Original preflight failure, reviewed concurrent-server provenance, and the earlier immutable approved plan remain preserved.

| Device | Last observed state | Remaining acceptance |
| --- | --- | --- |
| TB14P-EZRA, Windows | Offline/unreachable in the final trusted SSH probe; the exact 0.1.8 conditional invocation is armed, not installed | Reconcile old remote journals, run fresh same-host installer tests, supervised install/OTA proof, one-time enable and actual UI/tool callbacks |
| doesvm, Linux | Actual worker/supervisor remain 0.1.7; updater identified 0.1.8 and deferred because persistent kernel state is active | Preserve the kernel and allow the existing supervisor to proceed when safe; the five computer tools and headless capability check remain pending |
| Android / Termux, localhost-0a22 | Actual managed MCP owner is 0.1.8; exact legacy cache entry repaired; enable/reload completed; five tools and computer_info verified | The first signed-bridge setup returned exit 255; diagnose with the separate 0.1.9 patch, then complete owned ProbeActivity and actual MCP image/action acceptance |
| Android registration, localhost-8736 | Initially offline; observed online again at 21:10 UTC; physical identity is being reconciled | Read-only identity reconciliation, then independent update/acceptance as appropriate |

The Windows conditional invocation is `.tmp/windows-deployment-0.1.8/invocation.json`, SHA `820f0c4b12eaacce8cf2ff1fe580d50d62201804079652a2e3a4af98b6e81e7f`. Its activation receipt hashes to `8c69880b47129eddf8badbe526fd6a2c75a73284af7ca62b43bed8f16590975c`. It is enabled with `installationExecuted=false`; the template remains disabled. The final five-second trusted SSH probe did not establish identity, so no transfer or installation was started.

The doesvm observation at 20:20:53 UTC is preserved in `.tmp/doesvm-018-acceptance-20261123/acceptance.json`, SHA `9fb7990a0276f72a070cfe3e3953ef85dc53f2409ce8f49abebe2b66dc2e284d`. Exactly one normal update check was issued, request `d4a39764-a9d0-40e2-b20f-ced5e075f397`. The post-request status explicitly reports persistent-kernel deferral. Actual worker/supervisor entry hashes remain `fc1bf108...193f22fda`; configuration and the enabled/unpaused computer sidecar are unchanged. Fresh metadata still has 16 tools and no computer tools, so neither `computer_info` nor headless verification has been claimed.

A timeout is not evidence that a remote install had no effect. The Windows invocation must first reconcile all unresolved stages and journals. Its desktop CI receipt does not substitute for the new same-laptop installer receipt.

The existing follow-up automation tracks pending work. It uses the verified new CLI for computer management commands, records the enable/reload request once, preserves later local pause/disable choices, refreshes tool registration and checks actual device callbacks. The old bootstrap is not used for new computer subcommands.

No operator action resets, serializes or terminates a persistent kernel to speed up migration. The previous doesvm launcher/worker were observed absent and the existing managed service was verified active; their absence alone does not establish an exit cause or continuity of in-memory kernel state. A headless server can complete version/tool registration while accurately reporting no usable desktop.

## Capability boundaries

Windows requires an interactive user desktop. macOS currently controls the primary screen and needs the user's existing Screen Recording/Accessibility grants. Linux supports X11 with xdotool and ImageMagick; Wayland is reported separately. Android requires an already authorized su path; the signed input bridge restores the previous selected/enabled IME state.

Protected/locked desktops and unavailable OS grants are reported, not bypassed. Acceptance uses only owned test windows/activities. Input text and screenshots are not copied into routine request audit logs.

The deployment channel is HTTPS; no npm publication is claimed. See [capability documentation](computer-use.md) and [the deployment runbook](../deploy/computer/runbook.md).
