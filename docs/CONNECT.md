# 连接 ChatGPT / Claude 并配对设备

MCP endpoint：`https://relay.cyjin.dev/mcp`
传输：Streamable HTTP，直接返回 JSON（不提供 SSE；`GET /mcp` 返回 405）。

客户端只需要这一个 URL 和 **OAuth**；授权服务器地址、token 地址、PKCE 等由客户端自动发现，
不需要手工填写，也不需要 API key。

前提：

- 已有 `relay.cyjin.dev` 账号；邀请制开启时先在 `/welcome` 用邀请码激活
- 想暴露工具的机器装有 Node.js **22.5+**

## 1. 在 ChatGPT 中添加

1. 打开 ChatGPT 的 **Plugins** 页面，选择 **Add custom MCP server**。
   （菜单文案随客户端版本变化；认准 “custom MCP server / connector” 这类入口。）
2. 名称：`mcp-relay`
3. Server URL：`https://relay.cyjin.dev/mcp`
4. Authentication：选 **OAuth**（不要选 None，也不要填 API key）
5. 保存/添加后，ChatGPT 会自动请求 `/.well-known/oauth-protected-resource`，
   然后弹出浏览器跳到 relay 的 GitHub 登录和授权页。
6. 在同意页点 **允许**；浏览器回到 ChatGPT 后，工具列表里应出现 `devices_list`。

不需要手工输入 authorization endpoint / token endpoint；客户端通过 401 响应和
`.well-known` 元数据完成发现。

## 2. 在 Claude 中添加

1. **Settings → Connectors → Add custom connector**
2. 名称：`mcp-relay`；Remote MCP server URL：`https://relay.cyjin.dev/mcp`
3. 点击添加/连接，认证方式选 OAuth
4. 在浏览器同意页点 **允许**，返回 Claude 后启用该 connector

Claude Code 也可以用：

```bash
claude mcp add --transport http relay https://relay.cyjin.dev/mcp
```

然后在会话里执行 `/mcp` 完成 OAuth 登录。

## 3. 同意页意味着什么

同意页是 **relay 服务端渲染的 HTML**（Go 直接输出，无前端脚本），地址是
`https://relay.cyjin.dev/oauth/authorize`，表单提交到 `POST /oauth/authorize/decision`。
它不是 ChatGPT/Claude 的页面，所以样式和文案与客户端无关。

页面上会显示：

- 当前登录的 GitHub 账号
- 发起请求的客户端名称（来自 DCR 注册）
- 回调主机（client 的 `redirect_uri` 主机）
- 申请的 scope

scope 的含义：

| Scope | 允许的工具 |
| --- | --- |
| `relay.read` | `devices_list`，以及标注 `readOnlyHint` 的工具：`read`、`grep`、`find`、`ls`、`omp_read`、`omp_hash`、`omp_glob`、`omp_grep`、`omp_ast_grep` |
| `relay.write` | 写操作：`write`、`edit`、`bash`、`omp_apply_patch`；ChatGPT 通常会对写操作再次确认 |

行为细节：

- `devices_list` 本身要求 `relay.read`
- 客户端不传 `scope` 时，服务端按 `relay.read relay.write` 处理
- 同意后会记住该 client 的授权；后续请求的 scope 若是子集，不再弹同意页
- 要求更大的 scope（例如先前只有 read）会再次弹同意页
- 点 **拒绝** 会带 `error=access_denied` 回跳，客户端显示授权失败
- 只有 `relay.read` 时调用写工具，服务端返回 `403 insufficient_scope`，并在
  `WWW-Authenticate` 里给出所需 scope

## 4. 配对设备

设备由 CLI 主动向 relay 建立 WSS，所以在 NAT/防火墙后也能用。

1. 浏览器登录 `https://relay.cyjin.dev`，打开 **设备**
2. 点 **生成配对码**；配对码 **10 分钟内有效、只能使用一次**
3. 在要暴露工具的机器上运行：

```bash
npx -y @cyjin/mcp-relay connect \
  --code ABCD-EFGH \
  --root ~/code \
  --packs minimal,omp \
  --name laptop
```

常用参数：

| 参数 | 含义 |
| --- | --- |
| `--root <dir>` | 所有文件工具被限制在该目录（`realpath` 后比较，拒绝符号链接逃逸）；默认当前目录 |
| `--packs minimal,omp` | 工具包；默认两者都开 |
| `--name <name>` | 控制台显示名；默认主机名 |
| `--url <url>` | relay 地址，默认 `https://relay.cyjin.dev` |
| `--config <path>` | 设备配置路径，默认 `~/.mcp-relay/device.json` |
| `--no-shell` | 关闭 `bash` 工具 |

`kernel` pack 在当前构建中未发布；`--allow-kernel` 只是保留参数。

首次配对成功后，设备 token 保存在 `~/.mcp-relay/device.json`（权限 `0600`）。
之后不带 `--code` 直接运行会复用该 token；换 relay URL 时必须用新的配对码。
进程应保持常驻（例如 systemd 用户服务）；断线会自动重连（约 2 s 起，按 1 s × 2^attempt
指数退避，封顶 30 s，带少量抖动）。

撤销设备：控制台 **设备 → 撤销**。服务端会立即断开 WSS，CLI 以退出码 `3` 结束，
必须重新生成配对码。

CLI 退出码：`0` 正常；`2` 配置/配对失败；`3` 认证失败。

## 5. 验证 `devices_list`

在 ChatGPT/Claude 里让模型调用 `devices_list`（或直接问“列出我的设备”）。期望返回类似：

```json
{
  "devices": [
    {
      "slug": "laptop-3f2a",
      "name": "laptop",
      "platform": "linux",
      "arch": "x64",
      "packs": ["minimal", "omp"],
      "online": true,
      "last_seen": 1763000000
    }
  ],
  "hint": "tool names are d_<slug>__<tool>; only online devices appear in tools/list"
}
```

然后 `tools/list` 应出现带设备前缀的工具，例如 `d_laptop-3f2a__read`。
可以让模型执行：

> 用 d_laptop-3f2a__read 读取 README.md 的前 40 行。

控制台 `/audit` 会记录工具名、状态、耗时；参数只保存 SHA-256。

只有 **在线** 设备出现在 `tools/list`。设备离线时，已缓存的工具名调用会返回
`unknown tool: ... (call devices_list and refresh tools)`。

## 6. 期望的发现 URL 与协议

未认证请求 `POST /mcp` 的响应（客户端据此启动 OAuth）：

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://relay.cyjin.dev/.well-known/oauth-protected-resource", scope="relay.read relay.write"
```

受保护资源元数据：

```http
GET https://relay.cyjin.dev/.well-known/oauth-protected-resource
GET https://relay.cyjin.dev/.well-known/oauth-protected-resource/mcp
```

```json
{
  "resource": "https://relay.cyjin.dev/mcp",
  "authorization_servers": ["https://relay.cyjin.dev"],
  "scopes_supported": ["relay.read", "relay.write"],
  "bearer_methods_supported": ["header"],
  "resource_name": "mcp-relay"
}
```

授权服务器元数据：

```http
GET https://relay.cyjin.dev/.well-known/oauth-authorization-server
GET https://relay.cyjin.dev/.well-known/oauth-authorization-server/mcp
```

关键字段：

- `issuer`: `https://relay.cyjin.dev`
- `authorization_endpoint`: `https://relay.cyjin.dev/oauth/authorize`
- `token_endpoint`: `https://relay.cyjin.dev/oauth/token`
- `registration_endpoint`: `https://relay.cyjin.dev/oauth/register`（DCR，仅 public client）
- `revocation_endpoint`: `https://relay.cyjin.dev/oauth/revoke`
- `response_types_supported`: `["code"]`
- `grant_types_supported`: `["authorization_code", "refresh_token"]`
- `code_challenge_methods_supported`: `["S256"]`
- `token_endpoint_auth_methods_supported`: `["none", "client_secret_post", "client_secret_basic"]`
- `scopes_supported`: `["relay.read", "relay.write", "offline_access"]`
  （受保护资源元数据只列 `relay.read` / `relay.write`）
- `client_id_metadata_document_supported`: `false`
- `authorization_response_iss_parameter_supported`: `true`

客户端身份走 DCR：`POST /oauth/register`，接受
`token_endpoint_auth_method=none`（public，PKCE）、`client_secret_post` 或
`client_secret_basic`（后两者返回一次性 secret）。
CIMD 代码仍保留为未 advertise 的兼容路径，但 ChatGPT/Claude 会直接使用 DCR，避免
Claude 元数据 URL 的 Cloudflare 挑战。

其他约束：

- 授权码 10 分钟、一次性
- PKCE 必须是 `S256`
- `resource` 必须等于 `https://relay.cyjin.dev/mcp`，并写入 token audience
- access token 1 小时；refresh token 30 天，**每次刷新轮换**
- 授权成功跳转带 RFC 9207 的 `iss` 参数

### 新设备已在线，但当前会话没有它的工具

ChatGPT/Claude 在会话或连接建立时缓存 `tools/list`；新设备之后上线，不会自动把
`d_<slug>__*` 工具注入已有会话。先调用 `devices_list` 确认设备 `online`，然后：

1. 如果当前连接已有稳定的 `device_tools_list` / `device_call`，直接使用：
   ```json
   {"device":"localhost-0a22"}
   ```
   ```json
   {"device":"localhost-0a22","tool":"bash","arguments":{"command":"id"}}
   ```
   `device` 可以填 `devices_list` 返回的 `id`（`dev_...`）或 `slug`；`tool` 是
   `device_tools_list` 返回的原始工具名。
2. 如果这两个工具也不在列表里，说明连接是在它们部署前建立的：新开一个对话，
   或在 Apps/Plugins 详情页刷新/重新添加 connector。之后新设备无需再刷新工具列表。
3. `device_call` 没有 `readOnlyHint`，ChatGPT 会对调用要求确认；只读工具仍要求
   `relay.read`，写工具要求 `relay.write`。

## 7. 故障排查

### 反复 401

- 没带 token 或 token 过期：属正常；客户端应重新走发现/OAuth
- access token 只有 1 小时；刷新失败时客户端通常显示“需要重新连接”
- token 的 audience 必须等于 `https://relay.cyjin.dev/mcp`；改过 `BASE_URL` 后旧 token 全部失效
- 若客户端一直拿旧 token 重试，删除该 connector 再重新添加

设备侧的 401 是另一回事：`/device/ws` 返回
`WWW-Authenticate: Bearer realm="mcp-relay-device"`，CLI 会打印
`relay rejected the device token (HTTP 401); run again with a new --code` 并以 `3` 退出。
在控制台重新生成配对码，用 `--code` 重跑。

可以手工确认 401 形状：

```bash
curl -sS -o /dev/null -D - -X POST https://relay.cyjin.dev/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}' | grep -i '^www-authenticate'
```

### 发现失败

- `/.well-known/*` 返回 HTML、403 或验证码：Cloudflare 的 WAF/Bot Fight/Managed Challenge
  拦了非浏览器请求。给 `/.well-known/*`、`/oauth/*`、`/mcp`、`/device/ws` 加 skip 规则
- 证书错误：Cloudflare SSL 模式需 `Full (strict)`；源站证书必须覆盖 `relay.cyjin.dev`
- `BASE_URL` 必须是 `https://relay.cyjin.dev`（不能带尾斜杠、不能是 http），否则 metadata
  里的 issuer/resource 与客户端期望不一致
- DCR 注册失败：检查 `redirect_uris` 是否全部为 https 或 loopback http；429 时等限流窗口
- 客户端拿不到 `client_secret`：确认 DCR 响应里的 `token_endpoint_auth_method` 与 token
  请求一致

快速检查：

```bash
curl -i https://relay.cyjin.dev/.well-known/oauth-protected-resource
curl -i https://relay.cyjin.dev/.well-known/oauth-authorization-server
```

两者都应是 `200` + `application/json`。

### 刷新失败（invalid_grant）

- refresh token 已过期（30 天）或已被撤销
- **重放**：refresh 是一次性轮换；用旧 token 再刷会撤销整个 token family，
  后续所有刷新都返回 `invalid_grant`。处理方式：删除 connector 重新授权
- 客户端必须保存每次刷新返回的新 refresh token
- 手工撤销：`POST /oauth/revoke`，表单带 `token` 和 `client_id`

### `insufficient_scope`（403）

token 只有 `relay.read`，却调用了写工具。响应头类似：

```http
WWW-Authenticate: Bearer error="insufficient_scope", scope="relay.write", resource_metadata="https://relay.cyjin.dev/.well-known/oauth-protected-resource"
```

重新授权并同意 `relay.write`。若客户端只申请 read，需要在客户端侧开启写权限/重新连接。

### 工具不存在或设备不在列表

- `devices_list` 为空：设备离线、已撤销，或 `--root`/CLI 进程根本没起来
- CLI 日志应出现 `connected as <slug>` 和 `relay registered device <slug>`
- `tools/list` 只包含在线设备；设备刚上线时让客户端重新初始化/刷新工具
- 工具名格式固定为 `d_<slug>__<tool>`，不要手写成别的前缀

### 配对失败

- `invalid_code`：码已过期（10 分钟）、已使用或抄错；重新生成
- 配对接口按 IP 限流（10 次 / 10 分钟），超限返回 `429`
- `cannot reach relay`：设备所在网络需能出站访问 `https://relay.cyjin.dev:443`

## 8. 安全边界

- relay 只做鉴权、设备列表和调用转发；文件和命令都在设备上、`--root` 内执行
- 设备 token 只能用于 `/device/ws`，不能调用 MCP
- 审计只记录工具名、状态、耗时和参数的 SHA-256，不记录文件内容或 token
- `~/.mcp-relay/device.json` 与 `/etc/mcp-relay/env` 都是敏感文件，不要贴到聊天或提交到仓库

