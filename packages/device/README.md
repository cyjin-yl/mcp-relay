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
| `--no-shell` | Disable the `bash` tool |
| `--allow-kernel` | Enable the opt-in persistent `kernel` pack (VM, not a security boundary) |

## Tool packs

**minimal** (Pi-style): `read`, `write`, `edit`, `bash`, `bash_confirm`, `grep`, `find`, `ls`.
Search uses `rg` when installed and falls back to a bounded JS scanner.

**kernel** (opt-in, `--packs kernel --allow-kernel`): `kernel_eval`, `kernel_reset` with a persistent JS context and root-confined `relay.readFile/writeFile/list` helpers.

**omp**: `omp_read` (`:50-80` selectors), `omp_hash`, `omp_apply_patch`
(`*** Begin Patch`; `expected_hashes` is required for updates/deletes), `omp_glob`, `omp_grep`,
`omp_ast_grep` (requires the `ast-grep` binary), and `omp_ast_grep` uses
structural patterns such as `console.log($A)`.

On the relay these appear as `d_<device-slug>__<tool>`, for example
`d_laptop-3f2a__omp_apply_patch`.

## Safety

- Every path is resolved and confined to `--root`; symlink escapes are rejected.
- `bash` runs with a filtered environment and a 120 s maximum timeout.
- `write`/`edit` require the file to have been read in this device process and refuse to apply if it changed since that read.
- `omp_apply_patch` requires `expected_hashes` for every update/delete; call `omp_hash` first.
- Destructive bash commands (`rm -rf`, `dd`, `mkfs`, `shutdown`, `reboot`, recursive chmod/chown, etc.) are refused by `bash` and require a separate `bash_confirm` call with a one-time token. This is a speed bump, not a shell security boundary.
- Write tools require the `relay.write` OAuth scope; ChatGPT asks for confirmation by default.
- Device tokens are bearer secrets for the WebSocket only. They cannot call MCP.
- The relay never sees your files; it sees tool names, a SHA-256 of arguments, status and duration in the audit log.

## Environment

- Node.js 22.5+.
- Linux/macOS for `bash`; file tools work on Windows too, but the shell tool is disabled there.
- Optional: `rg` (ripgrep) and `ast-grep` for faster/structural search.

## License

MIT
