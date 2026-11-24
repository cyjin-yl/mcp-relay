# @cyjin/mcp-relay

Run a long-lived device agent that lets ChatGPT and Claude call a small, explicit tool set on your own machine through <https://relay.cyjin.dev>.

The relay only authenticates, lists your online devices, and forwards tool calls. Files and commands run on your device, inside the root you choose.

## Quick start

1. Sign in at <https://relay.cyjin.dev> with GitHub.
2. Open **设备** and generate a one-time pairing code.
3. On the machine that should expose tools:

```bash
npx -y @cyjin/mcp-relay connect --code ABCD-EFGH --root ~/code
```

The process stays connected, reconnects automatically, and responds to heartbeat pings. Re-running without `--code` reuses the saved device token in `~/.mcp-relay/device.json` (mode 0600).

## Options

| Flag | Meaning |
| --- | --- |
| `--code <code>` | One-time pairing code from the dashboard |
| `--root <dir>` | Confine every file tool to this directory (default: cwd) |
| `--packs minimal,omp` | Tool packs to expose (default: both) |
| `--name <name>` | Device name in the dashboard (default: hostname) |
| `--url <url>` | Relay base URL (default: `https://relay.cyjin.dev`) |
| `--config <path>` | Device config path (default: `~/.mcp-relay/device.json`) |
| `--no-shell` | Disable all shell tools, including Bash and PowerShell |
| `--allow-computer` | Enable native screenshot and input tools outside the file root (explicit opt-in) |
| `--allow-kernel` | Enable the opt-in persistent `kernel` pack (VM, not a security boundary) |
| `--no-auto-update` | Disable online automatic updates |
| `--update-manifest <https-url>` | Select a trusted release manifest (default: the configured relay origin, `/updates/device/stable.json`) |
| `--update-interval <seconds>` | Check interval, 10–86400 seconds (default: 300, with jitter) |

## Tool packs

**minimal** (Pi-style): `read`, `write`, `edit`, `grep`, `find`, `ls`, plus the available platform shell tools. Linux/macOS/Android Termux expose `bash` and `bash_confirm`. Windows exposes `powershell` and `powershell_confirm`; `bash` and `bash_confirm` are registered there only when native Git Bash is available. WSL application aliases are not treated as native Bash, and Bash commands are never implicitly interpreted as PowerShell.

Search uses `rg` when installed and falls back to a bounded JS scanner.

**kernel** (opt-in, `--packs kernel --allow-kernel`): `kernel_eval`, `kernel_reset` with a persistent JS context and root-confined `relay.readFile/writeFile/list` helpers.

**computer** (opt-in): `computer_info`, `computer_screenshot`, `computer_action`, `computer_handoff`, `computer_setup`, `computer_session`. Native PNG images, fresh-frame coordinates, bounded input, request deduplication, and persistent pause. Omit `lease_id` to operate the user's foreground programs; open an isolated `computer_session` and pass its `lease_id` to work in a separate input workspace. The model chooses the mode, and isolated failures never redirect input to the foreground. Foreground backends cover Windows, macOS, Linux X11, desktop-approved Wayland portals, local Proxmox VM consoles, and Android with existing su. Isolated providers cover native Windows Child Sessions, private Linux X11/Xpra desktops, and rooted Android 14+ with independent display focus; generic isolated macOS input is currently unavailable. Expiry and connection loss revoke input and preserve applications through a visible return path. See [computer use](../../docs/computer-use.md) for platform requirements, setup, mode selection, and recovery.

Wayland requires a desktop with both RemoteDesktop and ScreenCast portals, system Python/PyGObject, GStreamer with its PipeWire plugin, and explicit local sharing consent. Use the connected worker's `computer_setup` with `timeout_ms:120000`; info and screenshot calls never open permission prompts. Sessions close on disconnect, pause, cancellation or five idle minutes, and require fresh setup afterwards. Text is printable ASCII only; Unicode, newline and tab are rejected before input. This foreground portal does not change the Xpra/XWayland recovery requirement for isolated Linux workspaces.

Linux isolated launches receive a persistent home and application configuration directories for that lease, so ordinary browser profiles do not reconnect to the user's foreground instance. Recognized profile and existing-instance override flags are refused. Retained applications and their private profiles survive the visible handoff; choose foreground mode when the task needs an already-open application or its existing sign-in state. Applications still run with the device user's file permissions.

**omp**: `omp_read` (`:50-80` selectors), `omp_hash`, `omp_apply_patch`
(`*** Begin Patch`; `expected_hashes` is required for updates/deletes), `omp_glob`, `omp_grep`,
`omp_ast_grep` (requires the `ast-grep` binary), and `omp_ast_grep` uses
structural patterns such as `console.log($A)`.

On the relay these appear as `d_<device-slug>__<tool>`, for example
`d_laptop-3f2a__omp_apply_patch`.

## Safety

- File-tool paths are resolved and confined to `--root`; symlink escapes are rejected. Computer tools operate on the explicitly enabled OS desktop or PVE virtual console.
- Shell tools run with a filtered environment, a root-confined working directory and a 120 s maximum timeout. On POSIX, Bash discovery checks `MCP_RELAY_BASH`, `$PREFIX/bin/bash`, Termux's absolute bash, `/bin/bash`, `bash` on `PATH`, then `sh`. Windows uses explicit native PowerShell or Git Bash, preserves UTF-8 output and cancels the process tree on timeout.
- `write`/`edit` require the file to have been read in this device process and refuse to apply if it changed since that read.
- `omp_apply_patch` requires `expected_hashes` for every update/delete; call `omp_hash` first.
- Destructive Bash commands (`rm -rf`, `dd`, `mkfs`, `shutdown`, `reboot`, recursive chmod/chown, etc.) require a separate `bash_confirm` call with a one-time token. PowerShell operations such as `Remove-Item`, `Clear-Content`, `Stop-Process` and formatting commands require `powershell_confirm`. Tokens are bound to the command and shell. This is a speed bump, not a shell security boundary.
- Write tools require the `relay.write` OAuth scope; ChatGPT asks for confirmation by default.
- Device tokens are bearer secrets for the WebSocket only. They cannot call MCP.
- The relay forwards tool result bodies, including file contents and screenshots, to the authenticated caller. Routine audit logs contain tool names, argument hashes, status and duration rather than those result bodies.

## Online updates

Published 0.1.7-or-newer clients check the configured stable manifest every 300 seconds by default, with jitter. The launcher stages and verifies a release while the current worker remains available, waits for accepted work to finish, and switches both the worker and update supervisor. The final switch briefly reconnects the device; failed candidates roll back to the previous verified release. A live persistent kernel defers replacement until `kernel_reset`.

For a standalone bundle:

```sh
node cli.cjs connect --root <workspace> --config <device-config>
node cli.cjs update-status --config <device-config>
node cli.cjs update-check --config <device-config>
```

`update-status` reports the running worker/supervisor versions and update state without credentials. `update-check` requests an immediate check. Use `--no-auto-update` to opt out, or `--update-interval <seconds>` to change the interval.

The npm package and the standalone HTTPS artifacts are separate publication channels. Publishing `/updates/device/0.1.9/cli.cjs` does not publish that version to npm or change the version returned by `npx`. An existing npm client older than 0.1.7 cannot acquire this supervisor from code already loaded in its process: it needs a one-time migration to a verified standalone launcher, or to an appropriate newer npm release once that package is published. Subsequent online releases use the configured HTTPS manifest.

Keep the saved device config and identity during migration, and use a stable Node executable in the OS startup entry. See [Windows and online updates](../../docs/WINDOWS_AND_UPDATES.md) for the update lifecycle, kernel deferral, release integrity and recovery details.

## Environment

- Node.js 22.5+.
- Linux/macOS/Android Termux for Bash. Windows supports file tools and explicit PowerShell, preferring PowerShell 7 and falling back to Windows PowerShell 5.1. Native Git Bash is optional.
- Optional: `rg` (ripgrep) and `ast-grep` for faster/structural search.

## License

MIT
