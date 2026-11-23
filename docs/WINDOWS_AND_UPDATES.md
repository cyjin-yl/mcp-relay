# Windows shells and online device updates

The published client starts a small launcher, a release-specific update supervisor,
and one device worker. The worker owns the WebSocket and tool execution. The
supervisor stages and checks releases while that worker keeps serving requests.
The launcher selects the validated supervisor entry after a version handoff, so
future fixes to the update controller itself are also adopted.

## Windows behavior

Windows exposes `powershell` and `powershell_confirm` explicitly. PowerShell 7 is
preferred; Windows PowerShell 5.1 is the fallback. Commands are passed as
UTF-16LE encoded arguments, with UTF-8 output. Windows PATH lookup is
case-insensitive and the child environment includes the required Windows runtime
variables, without forwarding unrelated credentials.

`bash` is advertised on Windows only when a native Bash executable is found.
The WSL executables in System32 and the WindowsApps application alias directory
are not treated as Git Bash. Bash syntax is never silently interpreted as
PowerShell. Destructive-command confirmation tokens are bound to both the
command and its shell.

Timeouts/cancellation terminate the Windows process tree with `taskkill`. A
shell which has not actually exited retains the serialized mutation lane. If a
shell has exited but a detached descendant still holds its output handles, the
relay closes its own handles after a bounded output grace period, marks possible
truncation, and completes the call. It does not signal the user's detached
background process.

## Starting and inspecting a client

A published standalone bundle needs Node.js 22.5 or later. Its required runtime
dependencies, including `ws`, are bundled.

```sh
node cli.cjs connect --root <workspace> --config <device-config>
node cli.cjs update-status --config <device-config>
node cli.cjs update-check --config <device-config>
```

Pairing remains unchanged; use `--code` only for initial pairing. The launcher
passes restartable arguments to its children, never the one-time code or device
token. The existing config stays in place.

The default manifest is
`https://<configured-relay-origin>/updates/device/stable.json`. Checks occur every
five minutes with jitter; a local `update-check` request wakes the supervisor.
`--update-interval <seconds>` accepts 10 through 86400. An explicit
`--update-manifest <https-url>` selects another trusted release origin.
`--no-auto-update` opts out. Source execution through tsx skips the publication
supervisor; use the built artifact to test the full update flow.

## What an update guarantees

1. Download and preflight happen while the current worker remains online.
2. The manifest and artifact use HTTPS. Redirects and downloads stay on the
   manifest's origin. Responses have byte/time limits. SHA-256 must match before
   any downloaded candidate is executed.
3. Node syntax, imports and the reported version are checked before draining.
   Semantic version ordering prevents accidental downgrade.
4. The worker stops accepting new calls while draining. Accepted calls must
   actually finish, and their result-send callbacks must complete, before a
   drain acknowledgement is emitted. A timed-out operation still running in the
   executor continues to block replacement.
5. A busy worker defers the update. The supervisor resumes service rather than
   terminating a user's task just to install a release.
6. The candidate remains paused while authenticating, registering its tools and
   passing the stability window. WebSocket open by itself is not readiness.
7. State is committed atomically. A failed candidate is rolled back to the last
   verified release, and a failed digest receives a cooldown.
8. A release handoff also starts that release's supervisor. Only one worker uses
   a device identity at a time; the launcher does not grow a chain of supervisors.

This is an online update with a short reconnect at the final switch. It is not
an in-process replacement of an existing WebSocket.

### Persistent kernel sessions

An initialized kernel can hold values which cannot be serialized faithfully,
including functions and handles. Such a session defers automatic replacement
until the caller finishes it with `kernel_reset`. A call that creates kernel
state after a drain request is also detected before replacement is authorized.
The update status/log records the deferral; other tools remain usable.

## State and recovery

Each canonical config path has its own hashed update directory below the
config's `updates/` directory. Credentials are not copied into release state.
Release files are stored by digest, retaining the current and previous good
bundle so npm cache eviction does not remove the recovery copy.

The state journal records pending transitions and handoffs. Startup verifies the
saved artifact digest and recovers interrupted transitions. A kernel-owned
single-instance lock prevents two supervisors from serving the same state.
The public `update-status` output includes versions, phase, timestamps and
failure/deferral reasons, without tokens, argv or internal absolute paths.

Keep the original OS launcher environment. In particular, Android/Termux needs
its `PREFIX`, PATH and Android runtime variables. Windows launchers should use a
stable Node installation path rather than a temporary fnm multishell directory.

## Publishing an update

Build and validate in a development container:

```sh
npm ci
npm run typecheck
npm test -- --maxWorkers=2
npm run build:publish --workspace @cyjin/mcp-relay
node packages/device/test/packaged-smoke.mjs packages/device/dist/cli.cjs
```

The build writes:

- `release/device/<version>/cli.cjs`
- `release/device/<version>/cli.cjs.sha256`
- `release/device/stable.json`

Publish a new version directory first, verify its public SHA-256, then atomically
publish the manifest. Retain the prior manifest and release. Do not overwrite a
versioned artifact already served with immutable caching.

Serve `/updates/device/stable.json` with no-store/no-cache, and versioned bundles
with immutable caching. Keep updates outside the credential/state directory.
Validate the Caddy configuration before reloading it. Check downloads with the
actual Node client on the devices, since an edge service can treat clients
differently even when a curl health probe succeeds.

## Verification

Tests cover Windows environment and shell discovery, Unicode boundaries,
confirmation-token separation, real inherited-pipe completion, registration
readiness, task/result drain ordering, active kernel deferral, digest and origin
checks, candidate failure, rollback and supervisor handoff.

A rollout should verify the actual three-stage transition on each platform:
an internal bootstrap release starts, the published manifest is fetched, and
the verified final worker and supervisor appear in `update-status`. Confirm a
real tool call after reconnection and check that the original device identity
and config digest remain unchanged.
