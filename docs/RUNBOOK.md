# mcp-relay 运行手册（OVH · Debian 13）

本文只覆盖 `relay.cyjin.dev` 的生产运维。实际形态是 **Caddy 终止 TLS + Go 二进制 systemd 常驻**，
SQLite 与设备连接状态都在本机；不涉及容器编排。

- 公网入口：`https://relay.cyjin.dev/mcp`（MCP）、`/oauth/*`、`/.well-known/*`、`/device/ws`（WSS）
- 内部监听：`127.0.0.1:8080`，只允许 Caddy 访问
- 运维入口：SSH 与 `sudo` 均经 **TNA 跳板机**，OVH 主机不直接暴露 SSH；跳板地址、账号和密钥不在本文记录
- 服务名：`mcp-relay`（systemd），反向代理：`caddy`（systemd）
- 密钥只放在 `/etc/mcp-relay/env`，不要在命令行、聊天或工单里回显

> 与 `docs/PLAN.md` 的偏差：PLAN 早期写的是 Docker Compose；仓库实际的 `deploy/` 是
> `mcp-relay.service` + `Caddyfile` + `env.example`，没有 Dockerfile / compose.yaml / backup.sh。
> 本文以 `deploy/` 和 `server/` 代码为准。

## 1. 目录与权限

| 路径 | 属主:属组 | 权限 | 用途 |
| --- | --- | --- | --- |
| `/usr/local/bin/mcp-relay` | `root:root` | `0755` | Go 单文件二进制 |
| `/etc/mcp-relay/env` | `root:root` | `0600` | systemd `EnvironmentFile`，含 GitHub OAuth secret |
| `/var/lib/mcp-relay` | `mcp-relay:mcp-relay` | `0755`* | `DATA_DIR`；`relay.sqlite`、`-wal`、`-shm` |
| `/srv/relay/static` | `root:root` | `0755` | Caddy 托管的静态文件（`app.css`） |
| `/etc/caddy/Caddyfile` | `root:root` | `0644` | 站点与反代配置 |
| `/etc/caddy/certs` | `root:caddy` | `0750` | `relay.cyjin.dev.crt/.key`、`ovh.cyjin.dev.crt/.key` |
| `/etc/systemd/system/mcp-relay.service` | `root:root` | `0644` | 单元文件 |

`mcp-relay.service` 带 `StateDirectory=mcp-relay`，systemd 会自动创建 `/var/lib/mcp-relay`。
`*` systemd 在未设置 `StateDirectoryMode=` 时默认创建为 `0755`，SQLite 文件也按服务 umask 创建；
当前单元没有 `UMask=`/`StateDirectoryMode=`，建议在单元里补 `UMask=0077`（或 `StateDirectoryMode=0700`）
后重启，并手工收紧已有文件。单元启用了 `ProtectSystem=strict`，
`ReadWritePaths` 只放开 `/var/lib/mcp-relay`；若改 `DATA_DIR`，必须同步改这两处。

## 2. 首次安装与升级

构建（在源码目录，Go 版本不低于 `server/go.mod` 的要求）：

```bash
cd server
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /tmp/mcp-relay ./cmd/relay
cd ..
```

安装/升级二进制与单元（以下命令在仓库根目录执行）：

```bash
sudo useradd --system --home /var/lib/mcp-relay --shell /usr/sbin/nologin mcp-relay   # 仅首次
sudo install -m 0755 -o root -g root /tmp/mcp-relay /usr/local/bin/mcp-relay

sudo install -d -m 0755 /etc/mcp-relay
sudo install -m 0600 -o root -g root deploy/env.example /etc/mcp-relay/env           # 仅首次
sudo editor /etc/mcp-relay/env   # 填 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET；核对 BASE_URL、ADDR、DATA_DIR

sudo install -m 0644 deploy/mcp-relay.service /etc/systemd/system/mcp-relay.service
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-relay
```

静态文件与 Caddy（先安装 Caddy 2.8+，它会创建 `caddy` 用户/组）：

```bash
sudo install -d -m 0755 /srv/relay/static
sudo install -m 0644 deploy/static/app.css /srv/relay/static/app.css

sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile
sudo install -d -m 0750 -o root -g caddy /etc/caddy/certs
# 先把两个站点的证书放进 /etc/caddy/certs（第 5 节）；缺证书时 validate/启动会失败
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl enable --now caddy
```

升级时先保留旧二进制，再替换并重启。服务端调用预算与设备执行器需要一起升级，
具体预算、取消与限流规则见 [TRANSPORT.md](TRANSPORT.md)。

```bash
sudo install -m 0755 /usr/local/bin/mcp-relay "/usr/local/bin/mcp-relay.before-$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -m 0755 /tmp/mcp-relay /usr/local/bin/mcp-relay
sudo systemctl restart mcp-relay
```

设备包先安装到独立版本目录并验证，再停止旧启动器和旧进程，确认退出后用原来的
`--root`、`--config`、`--packs` 与 opt-in 参数启动新版。保留旧目录和启动脚本供回退。
不要同时启动使用同一个设备 token 的两个版本：旧进程会自动重连，双方可能反复替换连接。

设备 CLI 会自行重连（指数退避，上限 30 s），无需重新配对。
首次用 GitHub 登录 `ADMIN_GITHUB_LOGIN` 指定的账号会自动激活；`INVITE_REQUIRED=true` 时其他账号需在
控制台生成邀请码后于 `/welcome` 激活。

GitHub OAuth App 的回调地址固定为 `https://relay.cyjin.dev/auth/github/callback`。

## 3. 启停与健康检查

```bash
sudo systemctl status mcp-relay --no-pager
sudo systemctl restart mcp-relay
sudo systemctl stop mcp-relay
sudo journalctl -u mcp-relay -n 100 --no-pager

curl -fsS http://127.0.0.1:8080/healthz; echo
curl -fsS http://127.0.0.1:8080/readyz; echo
curl -fsS https://relay.cyjin.dev/healthz; echo
curl -fsS https://relay.cyjin.dev/readyz; echo
```

期望结果：

- `/healthz` → `{"ok":true,"service":"mcp-relay"}`
- `/readyz` → `{"ok":true}`；`503` 表示 SQLite `Ping` 失败

OAuth / MCP 冒烟检查：

```bash
# 未带 token：必须是 401，且带 WWW-Authenticate
curl -sS -o /dev/null -D - -X POST https://relay.cyjin.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'

curl -fsS https://relay.cyjin.dev/.well-known/oauth-protected-resource | jq .
curl -fsS https://relay.cyjin.dev/.well-known/oauth-authorization-server | jq .issuer
curl -fsS https://relay.cyjin.dev/static/app.css >/dev/null && echo static-ok
```

`GET /mcp` 返回 `405`（不提供 SSE），`DELETE /mcp` 返回 `204`，均为预期行为。

## 4. Caddy 配置与重载

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy          # 不中断现有连接
sudo systemctl status caddy --no-pager
sudo journalctl -u caddy -n 50 --no-pager
```

Caddy 管理 API 固定在 `127.0.0.1:2019`，不要对公网开放。

当前 `Caddyfile` 的职责：

- `relay.cyjin.dev`：`/static/*` 从 `/srv/relay/static` 读取（`handle_path` 会去掉 `/static` 前缀），
  其余全部 `reverse_proxy 127.0.0.1:8080`
- `ovh.cyjin.dev`：`/var/www/site` 静态站

注意：`deploy/Caddyfile` 里有 `header_up CF-Connecting-IP {remote_host}`，它会把该头覆盖为直连对端地址。
经 Cloudflare 代理时对端是 CF 边缘节点，**不是最终用户 IP**；服务端 `TRUST_PROXY=true` 时用它做限流和日志，
所以限流实际按边缘 IP 聚合。需要真实客户端 IP 时删掉这行 `header_up`，或显式配置可信代理。

改静态文件后无需重启 Caddy；`/static/app.css` 的响应头是 `Cache-Control: public, max-age=31536000, immutable`，
发布新文件名或变更 URI 才能绕过缓存。

## 5. TLS 证书与续期

`Caddyfile` 使用**静态证书**（`tls <crt> <key>`），Caddy 本身不做 ACME。证书来源二选一：

### A. Cloudflare Origin CA（推荐，配合代理）

- 在 Cloudflare 生成覆盖 `relay.cyjin.dev` 的 Origin Certificate（有效期最长 15 年）
- 写入 `/etc/caddy/certs/relay.cyjin.dev.crt`、`relay.cyjin.dev.key`，属主 `root:caddy`，私钥 `0640`
- Cloudflare SSL/TLS 模式必须是 **Full (strict)**
- 不需要 certbot 续期；到期前手工轮换

### B. certbot（Let's Encrypt）

Cloudflare 开代理时用 DNS-01，避免 HTTP-01 被代理干扰：

```bash
sudo apt install -y certbot python3-certbot-dns-cloudflare
sudo install -d -m 0700 /etc/letsencrypt/cloudflare
sudo editor /etc/letsencrypt/cloudflare/credentials.ini   # dns_cloudflare_api_token = <TOKEN_FROM_KEYRING>
sudo chmod 600 /etc/letsencrypt/cloudflare/credentials.ini
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare/credentials.ini \
  -d relay.cyjin.dev
```

续期后把证书部署到 Caddy 并重载。新建 `/etc/letsencrypt/renewal-hooks/deploy/mcp-relay-caddy.sh`：

```bash
#!/bin/sh
set -eu
DOMAIN=relay.cyjin.dev
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "/etc/caddy/certs/$DOMAIN.crt"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$DOMAIN/privkey.pem"   "/etc/caddy/certs/$DOMAIN.key"
systemctl reload caddy
```

```bash
sudo chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/mcp-relay-caddy.sh
sudo sh -n /etc/letsencrypt/renewal-hooks/deploy/mcp-relay-caddy.sh
sudo certbot renew --dry-run
sudo systemctl list-timers certbot.timer --no-pager
```

`certbot renew --dry-run` 默认 **不会** 执行 deploy hook；不要加 `--run-deploy-hooks`，
否则可能把 staging 证书复制进 `/etc/caddy/certs`。hook 的语法用 `sh -n` 检查，真实续期时才会执行。

验证：

```bash
openssl x509 -in /etc/caddy/certs/relay.cyjin.dev.crt -noout -subject -enddate
echo | openssl s_client -servername relay.cyjin.dev -connect relay.cyjin.dev:443 2>/dev/null \
  | openssl x509 -noout -subject -enddate
```

certbot 自带 timer 负责续期；deploy hook 负责“复制 + reload”。两者缺一，证书不会生效。

## 6. Cloudflare DNS 与代理

- DNS：`relay` 的 `A`（以及需要时的 `AAAA`）指向 OVH 公网地址，开启代理（橙云）
- 源站防火墙只放行 Cloudflare 的 80/443；SSH 只经 TNA 跳板
- SSL/TLS：`Full (strict)`；源站证书必须匹配 `relay.cyjin.dev`
- WebSocket：保持开启，设备走 `wss://relay.cyjin.dev/device/ws`
- WAF / Bot Fight Mode / Managed Challenge：必须对以下路径放行，否则客户端拿到 HTML 挑战页，
  表现为“发现失败”或 JSON 解析错误：
  - `/.well-known/*`
  - `/oauth/*`
  - `/mcp`
  - `/device/ws`
- 缓存：上述路径加 bypass 规则；服务端本身返回 `Cache-Control: no-store`，但不要让边缘缓存 `/mcp`
- Cloudflare 默认 Proxy Read Timeout 为 125 s；0.1.4 的 shell 最大内部响应预算为 123 s。
  部署时检查 Caddy transport 的读取限制，不能配置为早于该预算的值；普通工具仍为 20 s。

## 7. SQLite 备份与恢复

数据库：`/var/lib/mcp-relay/relay.sqlite`（WAL 模式）。
在线备份用 `sqlite3 .backup`，不要直接 `cp` 正在写入的库。

```bash
sudo apt install -y sqlite3          # 仅首次
sudo install -d -m 0700 -o root -g root /var/backups/mcp-relay
STAMP=$(date +%F-%H%M)
sudo sqlite3 /var/lib/mcp-relay/relay.sqlite \
  ".backup '/var/backups/mcp-relay/relay-$STAMP.sqlite'"
sudo sqlite3 "/var/backups/mcp-relay/relay-$STAMP.sqlite" "PRAGMA integrity_check;"   # 期望 ok
sudo find /var/backups/mcp-relay -name 'relay-*.sqlite' -mtime +14 -delete
```

冷备（没有 sqlite3 时）：

```bash
sudo systemctl stop mcp-relay
sudo cp -a /var/lib/mcp-relay/relay.sqlite* /var/backups/mcp-relay/
sudo systemctl start mcp-relay
```

恢复：

```bash
sudo systemctl stop mcp-relay
sudo install -m 0600 -o mcp-relay -g mcp-relay \
  /var/backups/mcp-relay/relay-2026-11-22-1200.sqlite \
  /var/lib/mcp-relay/relay.sqlite
sudo rm -f /var/lib/mcp-relay/relay.sqlite-wal /var/lib/mcp-relay/relay.sqlite-shm
sudo systemctl start mcp-relay
curl -fsS https://relay.cyjin.dev/readyz
```

库里只有 token / code / 设备 token 的 SHA-256，但仍有 GitHub 登录名和审计记录，按个人信息处理：
备份目录 `0700`，出机前加密。

## 8. 日志与审计

```bash
sudo journalctl -u mcp-relay -f                 # 应用日志（JSON 行）
sudo journalctl -u mcp-relay --since '1 hour ago' --no-pager
sudo journalctl -u caddy -n 100 --no-pager
```

- 应用把结构化日志写到 stdout，由 journald 收集：`listening`、每条 `request`（method/path/status/ms/ip）、
  `panic`、`stopped`
- 应用不写日志文件；`DATA_DIR` 下只有 SQLite
- `Caddyfile` 未配置 access log，Caddy 只记进程日志；需要访问日志时在站点块加 `log` 指令
- 工具调用审计在网页 `/audit`（最近 100 条）与 `audit_log` 表；参数只存 SHA-256，不存原文
- `mcp-relay` 每小时执行一次清理：过期 session/code/token/配对码，以及 30 天前的审计记录

## 9. 回滚：Caddy 故障时恢复 nginx

先停 Caddy 释放 80/443，但**不要卸载**，保留配置以便回滚回去。

```bash
sudo systemctl stop caddy
sudo systemctl disable caddy
```

`/etc/nginx/sites-available/relay.cyjin.dev`（在 `http {}` 中需要有
`map $http_upgrade $connection_upgrade { default upgrade; '' close; }`）：

```nginx
server {
    listen 80;
    server_name relay.cyjin.dev;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;
    server_name relay.cyjin.dev;

    ssl_certificate     /etc/caddy/certs/relay.cyjin.dev.crt;
    ssl_certificate_key /etc/caddy/certs/relay.cyjin.dev.key;
    client_max_body_size 2m;

    location /static/ {
        alias /srv/relay/static/;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP $http_cf_connecting_ip;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 130s;
    }
}
```

```bash
sudo ln -sfn /etc/nginx/sites-available/relay.cyjin.dev /etc/nginx/sites-enabled/relay.cyjin.dev
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx

curl -fsS https://relay.cyjin.dev/healthz
curl -sS -o /dev/null -D - -X POST https://relay.cyjin.dev/mcp \
  -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

恢复 Caddy：`sudo systemctl disable --now nginx && sudo systemctl enable --now caddy`。
两台反代不要同时监听 80/443。

## 10. 常见故障

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| Caddy 返回 502/504 | `systemctl status mcp-relay`、`curl 127.0.0.1:8080/healthz` | 服务挂了或 `ADDR` 与反代不一致 |
| 页面无样式 / static 404 | `ls -l /srv/relay/static/app.css` | 安装静态文件；确认 `handle_path` 路径映射 |
| 登录页提示“GitHub 登录未配置” | `/etc/mcp-relay/env` 的 client id/secret | 补齐后 `systemctl restart mcp-relay` |
| 新用户登录后停在 `/welcome` | `INVITE_REQUIRED`、`users.status` | 管理员在控制台生成邀请码 |
| 客户端 401 循环 | 证书、Cloudflare 挑战、token audience | 见 `docs/CONNECT.md` 的“401 / 发现失败” |
| 设备一直离线 | `journalctl -u mcp-relay` 是否有 WSS 升级；CLI 日志 | token 被撤销则重新配对；网络需出站 443 |
| 证书过期 | `openssl x509 -enddate`、`certbot renew --dry-run` | 修 deploy hook 或轮换 Origin CA 证书 |
| 磁盘告警 | `df -h /var`、备份目录、SQLite WAL 大小 | 清理旧备份；`PRAGMA wal_checkpoint(TRUNCATE)` |


## Backup and monitoring

- Daily SQLite backup: `mcp-relay-backup.timer` (03:20 UTC, `Persistent=true`) runs
  `/usr/local/bin/mcp-relay-backup`, writes `/var/backups/mcp-relay/relay-<UTC>.sqlite`
  via Python's `sqlite3.backup`, verifies `PRAGMA integrity_check`, and deletes
  backups older than 14 days.
- Check: `systemctl list-timers mcp-relay-backup.timer` and
  `ls -lh /var/backups/mcp-relay | tail`.
- Uptime Kuma monitor `mcp-relay — public health` (id 53) checks
  `https://relay.cyjin.dev/healthz` every 60 s from CT102; it proves only the
  public Cloudflare → Caddy → Go health path, not OAuth, MCP tools or device
  online state.
- Kuma policy mirror: `life/areas/technology/home-lab/doesvm/kuma-monitor-policy.json`.
