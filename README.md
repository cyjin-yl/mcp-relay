# mcp-relay

ChatGPT and Claude MCP connector for devices you control.

- Public endpoint: `https://relay.cyjin.dev/mcp` (Streamable HTTP, JSON responses)
- Auth: self-hosted OAuth 2.1 AS (DCR with public/secret clients + PKCE S256 + resource audience binding)
- Device agent: `npx -y @cyjin/mcp-relay connect --code ...` (outbound WSS, no inbound ports)
- Server: Go + SQLite on OVH, Caddy for TLS/static, Cloudflare proxy
- Tool packs: minimal file/shell tools, OMP hash-anchored patches/search, an optional persistent kernel, and opt-in native computer use (Windows, macOS, Linux X11, rooted Android)

## Layout

```
server/            Go relay (OAuth AS, MCP, WSS device router, JSON API)
packages/device/   TypeScript npx device agent and tool packs
packages/shared/   Shared protocol types used by the device
web/               Proto-UI shadcn Web Components dashboard (static, /app/)
deploy/            Caddyfile, systemd unit, env template, static assets
docs/              PLAN, RUNBOOK, CONNECT
```

## Local check

```bash
npm install
npm run typecheck
npm test                          # device tests
cd server && go test ./...        # relay tests
```

## Production check

```bash
curl -sS https://relay.cyjin.dev/healthz
curl -sS https://relay.cyjin.dev/.well-known/oauth-protected-resource
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://relay.cyjin.dev/mcp
```

The last request must return `401` with a `WWW-Authenticate` pointer to the protected
resource metadata.

See [docs/CONNECT.md](docs/CONNECT.md) for ChatGPT/Claude setup and
[docs/RUNBOOK.md](docs/RUNBOOK.md) for operations.

See [Native computer use](docs/computer-use.md) for screen/input capabilities, explicit enablement, platform requirements, handoff, and update behavior.
