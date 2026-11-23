# 设备调用、超时与限流

本文描述当前设备源码中的 transport、Windows shell 与更新行为；发布渠道和实装版本见
[Windows 与在线更新说明](WINDOWS_AND_UPDATES.md)。服务端与设备需要一起更新，
仅更新工具列表不能改变旧设备进程的执行逻辑。

## 调用顺序

每个设备保留一个写入队列：shell、对应的确认工具、文件修改、patch 和持久 kernel
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
执行器。正在执行的 shell 收到取消时，POSIX 请求终止自己的进程组，Windows 使用
`taskkill /T /F` 请求终止进程树；只有执行器实际返回后才会释放写入位置。

直接 shell 已退出后，执行器最多再等待 1 秒排空继承的输出管道。若后台子进程仍持有
管道，执行器关闭自己的管道端、标记截断并返回后台进程可能仍在运行的警告，然后释放
写入位置。这个宽限计时不会让仍存活的直接 shell 提前释放位置，也不保证清理主动脱离
的后台进程。外部系统已经接受的工作，例如远程 SSH 服务或容器内独立任务，不能靠结束
本地 shell 撤销。

`bash.timeout_ms` 和 `powershell.timeout_ms` 保持 1–120 秒、默认 30 秒。服务端给 shell
预算增加 1 秒用于回收，再留 2 秒接收设备的结果；普通工具保持 20 秒执行预算。
对应的确认工具使用设备保存的一次性确认记录中的原始命令、目录和超时，服务端为其
保留最大 shell 预算。
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

POSIX 工具解析可执行的 Bash 或 sh：Bash 使用 `--noprofile --norc -c`，sh 使用 `-c`，
并保留明确传入的 `PATH`、`HOME` 等环境。Windows 使用原生 PowerShell 或 Git Bash，
不把 WSL 启动器当作本机 Bash。需要特定初始化的命令应显式写出相应初始化步骤。

POSIX 解析支持 `MCP_RELAY_BASH`、`PREFIX`、`PATH` 和系统候选位置。相对候选先按
设备进程的工作目录变成绝对路径，再对同一路径校验和执行，因此工具切换 `cwd` 不会
选择另一个同名程序。Windows 的候选路径也在校验前绝对化，显式 override 仍必须是
绝对 `.exe` 路径；WSL 排除在路径规范化后执行。

Android 设备 shell 额外保留八项固定系统路径变量：`ANDROID_DATA`、`ANDROID_ROOT`、
`ANDROID_RUNTIME_ROOT`、`ANDROID_ART_ROOT`、`ANDROID_I18N_ROOT`、`ANDROID_TZDATA_ROOT`、
`BOOTCLASSPATH`、`DEX2OATBOOTCLASSPATH`。它们供 ART、`app_process` 与 Termux-X11 使用。
其它环境变量仍按原有白名单过滤，凭据和 `LD_PRELOAD` 不因这个修复透传。
Android 使用同一套 POSIX 查找规则，支持 Termux 的私有安装前缀，不依赖 `/bin/bash`
存在或父进程加载路径重写 hook。

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
