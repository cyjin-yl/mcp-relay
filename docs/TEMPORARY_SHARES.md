# 临时设备访问分享

控制台 `/app/` 的 **临时分享** 页可以把一个或多个已配对设备临时交给另一个 MCP 客户端或 agent。
设备可以暂时离线；接收方只有在设备上线后才能调用其工具。

## 使用流程

1. 在控制台选择 1–32 台设备，填写可选名称，选择操作权限或只读工具。
2. 设置 5 分钟至 7 天的有效期，默认 1 小时。计时从创建时开始；页面显示含时区的准确截止时间。
3. 点击 **生成分享链接**，复制链接或 **复制给 agent 的说明**。链接只在本次页面中显示，刷新后不能找回。
4. 接收方打开完整链接，明确领取一次。浏览器可点击 **领取访问文件**；agent 可按 Markdown 说明调用领取 API。
5. 接收方保存领取响应中的 Markdown 文件，按其中的 MCP 连接步骤操作所选设备。
6. 所有者随时可在分享记录中撤销。撤销和到期都使该分享的后续访问失效，设备仍保留原有配对与连接。

分享状态由服务器确认。本机倒计时仅供参考；设备时钟偏快或偏慢，不会隐藏仍有效分享的撤销入口，也不会清除尚待领取的链接。

**阅后即焚的对象是领取凭据。** 链接只能成功领取一次；领取到的独立 Bearer token 可在剩余有效期内重复使用。
服务器不能删除接收方已经保存的文件，但会实时拒绝已撤销或已到期 token 的访问。

## 领取链接与连接文件

链接形态为 `https://relay.example/share#claim=mrclaim_…`。秘密放在 fragment 中，普通 HTTP GET 不会把它发给服务器。
聊天预览、GET 和 HEAD 都不会消耗链接。无浏览器 HTML Accept header 时，落地页默认返回 Markdown 领取说明。

agent 必须保留所有者给出的**原始完整链接**，从 `#claim=` 提取一次性凭据，然后发送：

```http
POST /api/share-claims
Content-Type: application/json
Accept: application/json

{"claimToken":"<原始链接中的 mrclaim_…>"}
```

成功响应包括：

| 字段 | 内容 |
| --- | --- |
| `accessToken` / `tokenType` | 独立的 `mrshare_…` Bearer token |
| `mcpUrl` | 该 relay 的 `/mcp` 地址 |
| `share` | 名称、固定设备集合、scope、创建及领取时间 |
| `expiresAt` | 固定的 Unix 秒截止时间 |
| `filename` / `document` | 适合保存的文件名及完整 Markdown 连接文件 |

连接文件包含机器可读 manifest、UTC 到期时间、所选设备 ID、scope、完整 HTTP headers、初始化及工具调用示例。
协议版本明确为当前实现支持的 `2025-11-25`，使用 `initialize → notifications/initialized → tools/list → tools/call`。
每次请求使用 `Authorization: Bearer <accessToken>`；不把 token 放入 URL。

需要能设置 Authorization header 的 Streamable HTTP MCP 客户端或能发送 HTTP 请求的 agent。
只提供 OAuth 登录的客户端需要合适的桥接器；分享接收方不需要登录所有者账户。
该服务器不返回 MCP session ID，也不提供独立 SSE stream，因此 `GET /mcp` 的 405 不表示连接失败。

成功领取响应丢失时，不能重新领取或恢复明文 token。所有者应撤销该分享，再创建新链接。
领取接口的 410 统一表示已领取、已到期、已撤销或无效；不会向未知访问者披露设备信息。

## 权限和撤销语义

- 分享固定绑定设备 ID，之后新配对的设备不会自动加入。单独撤销设备也会使该设备从分享的可用范围移除。
- **只读工具**使用 `relay.read`；**操作设备**使用 `relay.read relay.write`，可调用所选设备已启用的 shell、写文件、kernel 或 computer input 等工具。
- 已启用 PVE computer backend 的宿主设备代表该宿主的所有 VM 控制台，包括之后新增的 VM；设备分享不提供单独的 VM 子集筛选。只读分享可观察其可用控制台，操作分享还可发送输入。
- scope 是 relay 工具级权限，设备进程仍按自身 OS 账户、根目录及已有工具配置运行。
- 分享不产生 owner session，不能管理控制台、重新配对设备、创建新分享或取得 OAuth refresh token。
- 每次 MCP 请求都会校验授权；读完请求体后再次校验，避免慢传请求跨过撤销或到期后继续发现设备信息。
- 真正派发工具前再次检查分享和设备状态。等待 websocket 写锁的请求也会重新检查。
- 运行中调用关联可取消 context；手动撤销会取消该分享的调用，到期自动触发 deadline。设备收到的排队与执行预算不会超过授权截止时间。
- 已完成的修改或已经脱离执行的外部进程不会自动回滚。设备与网络能够处理取消时，relay 会发送取消通知。

分享 API 只接受已有登录会话；创建与撤销还要求 session 对应的 `X-CSRF-Token`。
Bearer 分享 token 仅用于 MCP，不是控制台的登录凭证。

## 管理 API

| 请求 | 行为 |
| --- | --- |
| `GET /api/shares` | 返回当前所有者的分享元数据，不返回任何凭据或凭据哈希 |
| `POST /api/shares` | `{label, deviceIds, permission: "read" 或 "write", ttlSeconds}`；返回 `{share, claimUrl}` |
| `POST /api/shares/{id}/revoke` | 幂等撤销当前所有者的分享，返回 `{ok:true}` |
| `POST /api/share-claims` | 匿名调用，但必须具有独立的一次性领取凭据 |

每个账户最多 100 个未撤销且未到期分享。记录列表最多返回 200 条，优先展示所有仍有效的分享，确保它们始终保留撤销入口。
已终止的历史记录保留 30 天。事件及工具调用以 `share:<id>` 为独立审计主体；审计不保存原始凭据。

## 存储与并发

`device_shares` 保存分享及两个凭据的 SHA-256；`device_share_devices` 保存设备集合。
创建返回一次明文领取凭据；领取返回一次明文访问 token。领取的条件 UPDATE 和 token 写入处在同一事务中。
首个写操作取得 SQLite 锁，UPDATE 内用 `unixepoch()` 判断当前时间，防止等待写锁的请求在到期后继续领取。
领取成功后清空 `claim_hash`，撤销后清空两种 hash。没有恢复 token 或延长有效期接口。

响应使用 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。浏览器把 fragment 留在页面内存后清除地址栏，
不使用 localStorage。领取页无第三方资源；内容展示使用文本节点，动态标签及设备名不作为指令执行。

## 验证

```bash
cd server
go test ./...
go test -race ./internal/app -run '^TestShare' -count=1
cd ../web
npm ci
npm run build
npm run lint
```

Go 回归覆盖并发领取、GET/HEAD 预览、设备与 scope 隔离、两个工具入口、控制台及 refresh 隔离、已初始化客户端撤销、
排队和运行中取消、到期执行预算、慢传请求、数据库重开、写锁等待跨过期及有效分享的可见性。

完整浏览器验证在 `scripts/share-browser-smoke.mjs` 中使用独立临时数据库、真实 Go relay、测试设备 websocket 与构建后的控制台。
它不读取或操作生产账户、设备与凭据。运行方式及结果见对应 CI 工作流。

## 发布与回退

这是服务端和控制台功能，现有支持取消与执行预算的设备客户端无需为分享重新配对或安装。
发布应把 Go 二进制和 `web/dist` 作为同一次变更验收，并按运行手册先备份 SQLite。
迁移只增加两张表及索引，不改写原账户、session、OAuth token 或设备记录。
回退到旧服务端时，新分享 token 因无法被识别而失效；恢复本版本后仍按数据库内的原截止时间与撤销状态处理。

协议参考：[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、
[Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、
[Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)。
