# 设备调用、超时与限流

本文对应服务端修复和设备包 `@cyjin/mcp-relay@0.1.4`。服务端与设备需要一起更新；
仅更新工具列表不能改变旧设备进程的执行逻辑。

## 调用顺序

每个设备保留一个写入队列：`bash`、`bash_confirm`、文件修改、patch 和持久 kernel
按接收顺序执行。同一个 kernel 与文件状态在重连后继续使用同一个写入队列。
即使旧执行器没有立即响应取消，新连接的修改也必须等它真正结束。

标为 `readOnlyHint=true` 的工具使用独立队列，最多同时执行四个。一个较长的 shell
不会单独占用所有文件读取机会。服务端仍最多允许每设备八个在途调用；设备端另有
32 个待完成调用的上限，超限立即返回 busy。

文件读取登记的 SHA-256 来自返回文本对应的同一次字节快照。之后修改仍会核对当前
内容，拒绝已观察到的文件变化。这是设备连接范围内的乐观检查，不是跨所有客户端、
所有外部进程的原子事务。

## 超时与取消

调用预算从设备收到请求时开始，包含排队时间。已经过期或取消的排队项不会再调用
执行器。正在执行的 shell 收到取消时向自己的进程组发送 `SIGKILL`；只有执行器实际
返回后才会释放写入位置。该信号受系统权限约束：`sudo` 或改变 UID 的后代可能不允许
普通用户终止，独立会话、远程 SSH 服务和容器内任务也可能继续运行。参见
[Linux kill(2) 的权限规则](https://man7.org/linux/man-pages/man2/kill.2.html)。

直接子进程退出也不代表继承输出管道的后代已经结束。若后代仍持有管道，执行器会继续
占用写入位置，后续写请求可能在排队阶段到期；读取队列仍可服务。这是取消未确认时的
保守状态，不应把 timeout 当作提权或外部任务已撤销的回执。长构建和运维任务应在其
执行域启动有界任务并保留可查询的 job 标识；日志放在设备 root 内，便于独立的 `read`
读取阶段结果。确认真实任务归属、状态和结果后再中止或重试，不能通过重启 relay 跳过
尚未结束的写入。

`bash.timeout_ms` 保持 1–120 秒、默认 30 秒。服务端给 shell 预算增加 1 秒用于回收，
再留 2 秒接收设备的结果；普通工具保持 20 秒执行预算。`bash_confirm` 使用设备保存
的一次性确认记录中的原始命令、目录和超时，服务端为它保留最大 shell 预算。
服务端等待 WebSocket 发送锁的时间也扣除；不会在调用结束后再向设备发送迟到的命令。

取消信号覆盖 HTTP 请求上下文结束、服务端超时、设备 `cancel` 消息和 WebSocket
断连。本版本没有实现跨独立 HTTP 请求的 MCP `notifications/cancelled` / `requestId`
关联取消；该通知仍返回 202，不应把这个响应当作设备执行已经取消的回执。

HTTP 服务未设置 `WriteTimeout`；`ReadTimeout` 管理读取请求，`IdleTimeout` 管理空闲
连接。部署时仍需核对反向代理限制。Cloudflare 的公开连接限制表在 2026-11-13 更新后
列出的默认 Proxy Read Timeout 为 125 秒；最大内部响应预算为 123 秒，不能再叠加
额外的代理等待预算。见 [Cloudflare 连接限制](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)。

## 限流范围

所有窗口均为滚动 60 秒：

| 请求类别 | 上限 | 分组依据 |
| --- | --- | --- |
| 发现、初始化、控制请求 | 120 | 已认证用户与 OAuth client |
| 已校验设备及工具的执行请求 | 120 | 已认证用户、OAuth client 与设备 |
| 以上全部请求 | 360 | 已认证用户 |

`device_call` 与对应的 `d_<slug>__*` 工具共享同一个设备额度。不存在的设备或工具
进入控制请求额度，不会因任意设备字符串分配无限的新额度。不同设备有各自执行额度，
控制请求不能直接消耗设备执行额度，但所有请求仍受账号总额度限制。

HTTP 429 同时返回 `Retry-After` 秒数和 JSON 的 `retry_after`、`scope`。等待时间按最早
一条占额请求离开窗口的剩余时间向上取整；遇到 429 应按它等待，不立即重复请求。

## Shell 与 Android 的运行环境

工具通过非登录的 `bash -c` 执行命令，保留明确传入的 `PATH`、`HOME` 等环境，
不会隐式加载用户的登录 profile。需要特定初始化的命令应显式写出相应初始化步骤；
登录启动脚本中的网络请求或其它副作用不再消耗每次工具调用的执行时间。

Android 设备 shell 额外保留八项固定系统路径变量：`ANDROID_DATA`、`ANDROID_ROOT`、
`ANDROID_RUNTIME_ROOT`、`ANDROID_ART_ROOT`、`ANDROID_I18N_ROOT`、`ANDROID_TZDATA_ROOT`、
`BOOTCLASSPATH`、`DEX2OATBOOTCLASSPATH`。它们供 ART、`app_process` 与 Termux-X11 使用。
其它环境变量仍按原有白名单过滤，凭据和 `LD_PRELOAD` 不因这个修复透传。
Android 从明确继承的 `PATH` 解析 `bash`，支持 Termux 的私有安装前缀；不依赖 `/bin/bash`
存在或父进程加载路径重写 hook。其它受支持的 Unix 平台继续使用 `/bin/bash`。

## 验证入口

```bash
npm run build
npm test -- --maxWorkers=2 --minWorkers=1 --no-file-parallelism
cd server
go test ./...
```

回归包含：长 shell 期间读取、排队写入过期、真实 WebSocket 重连时 kernel 顺序、进程组
取消后的延迟副作用、文件快照一致性、Android 环境白名单、按设备限流、总量限制，以及
HTTP 取消和发送锁阻塞时不发送迟到命令。部署验收还需真实执行超过 20 秒的 shell，
同时调用读取工具，并保留旧设备包用于有序回退。
