# 0.1.7 验证与生产发布记录（2026-11-23）

本记录对应 Windows relay 兼容性、设备在线自动更新和服务端执行预算修复。生产服务、版本化文件与稳定清单均已发布；设备首次迁移按其验收和状态保护条件推进。下列结果来自本轮实际构建、测试和生产读回，时间统一标明时区。

## 已验证的构建

构建均在独立的 CT102 Docker 环境中完成。TypeScript 构建容器限制为 2 CPU / 4 GiB，Vitest 使用最多 2 个 worker。Go 使用独立容器、相同资源上限及既有模块缓存；没有降低 `server/go.mod` 的 Go 版本要求。

| 检查 | 结果 |
| --- | --- |
| Node / npm | Node 22.23.2 / npm 10.9.8 |
| 依赖安装 | `npm ci`，退出码 0 |
| TypeScript | `npm run typecheck`，退出码 0 |
| 全量单元测试 | `npm test -- --maxWorkers=2 --minWorkers=1`，14 个文件、92 项测试通过 |
| 自包含发行包 | `npm --workspace @cyjin/mcp-relay run build:publish`，退出码 0；`ws` 已打入单文件 |
| 完整包运行检查 | `node packages/device/test/packaged-smoke.mjs packages/device/dist/cli.cjs`，退出码 0 |
| Go | 实际工具链 Go 1.27.0；`go test ./...` 通过，`internal/app` 用时 10.651 秒 |
| Go 发行构建 | `CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-s -w" ... ./cmd/relay`，退出码 0 |

最终 TypeScript 验证前后对 42 个源码、测试、配置及构建输入计算 SHA-256，结果完全相同。Go 构建只对本轮修改的 `devices.go` 与 `transport_test.go` 执行 gofmt；随后记录独立的 Go 输入快照。

单元测试覆盖真实子进程的 drain、候选启动和回退、错误摘要拒绝、持久 kernel 的延期、连接重建、完整 supervisor 的 A→B→C 接续、损坏接续状态的恢复，以及 Windows shell / PowerShell 参数处理。另有真实子进程回归，覆盖 shell 已退出但后台后代继承输出管道时的收尾。

完整包检查获得以下结果：

| 项目 | 实际结果 |
| --- | --- |
| 注册工具数 | 16 |
| 长 shell | 22,142 ms，完成 |
| 同时进行的只读调用 | 2 ms |
| 已过期写请求 | 未产生写入 |
| 已取消子进程的延迟副作用 | 未发生 |
| 持久 kernel | 保持 |

## 固定的发行文件

同一路径的既有文件不会以不同内容覆盖。下载后应按下表校验 SHA-256。

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `device/0.1.7/cli.cjs` | 1,211,557 | `fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda` |
| `device/0.1.7/windows-bundle-smoke.cjs` | 148,467 | `df15aa1d35bd6d58102b63674e1e2509ba97d05d0e4cc5aa1fe719b2b64c3a0e` |
| `device/0.1.7/windows-bundle-smoke-v2.cjs` | 148,479 | `38ae99ff485ef22baeb35f2c31a3482dbe64309b20a1fddc032d598f8a651a61` |

服务端二进制 `mcp-relay-linux-amd64` 的 SHA-256 为：

```text
27fbf94ecdfd08e34ba33620f087b6cb732ae3c10d68c55511de2b61611029b6
```

版本化下载地址：

- [设备 CLI](https://relay.cyjin.dev/updates/device/0.1.7/cli.cjs)
- [最初的 Windows 验收程序](https://relay.cyjin.dev/updates/device/0.1.7/windows-bundle-smoke.cjs)
- [Windows 验收程序 v2](https://relay.cyjin.dev/updates/device/0.1.7/windows-bundle-smoke-v2.cjs)

Windows 第一轮 CI 发现验收程序直接比较了 Windows 长路径与 8.3 短路径别名。v2 仅将 actual / expected cwd 通过 `realpathSync.native(...).toLowerCase()` 归一化后比较，保留独立的目录越界断言。旧验收文件保留在原 URL，CLI 内容及其摘要没有变化。第二轮 CI 使用新 URL 和新摘要，于北京时间 2026-11-23 21:21:03（UTC+8）完成。10 项原生 Windows 用例、下载文件摘要校验以及两份 PowerShell 脚本的 PS 5.1 语法检查均通过，见 [Windows 验收记录](https://github.com/cyjin-yl/mcp-relay/actions/runs/45182925568)。

## 生产服务切换

生产变更通过独立的 systemd 一次性任务执行。控制该任务的 SSH 与本地 tmux 不依赖正在重启的 MCP HTTP 请求，避免远端服务重启使发布步骤停在中途。

实际顺序为：

1. 校验上传文件的摘要，并保存正在运行的 Go 二进制及原 Caddy 配置。
2. 在写入前重新比较 live 二进制、live Caddy 配置和已校验候选的摘要。
3. 校验 Caddy 配置，原子替换候选二进制和配置，再 reload Caddy、restart Go 服务。
4. 检查源站 `/healthz`、`/readyz`，并通过本地 TLS / Caddy 读取两份版本文件，核对完整摘要。
5. 如变更后的健康检查失败，恢复两份备份，重新加载服务，并记录回滚健康状态。

本次最终状态为 `healthy`，`rollback_performed=false`。Go 服务已运行上述 `27fbf94e…` 二进制。Caddy 配置 SHA-256 为：

```text
a7b13d09bb33a3d3c8af52403e09d49e1a5a55b44472302c1e95be83c98a017d
```

新增 `/updates/*` 文件路由指向 `/srv/relay/updates`，响应设置 `Cache-Control: no-store`。原 `/static/*` 与 `/app/*` 路由继续按各自配置工作。

本次备份目录为：

```text
/var/backups/mcp-relay/device-update-0.1.7-20261123-831f3722823f/
```

目录中保存 `mcp-relay.before`、`Caddyfile.before`、各自候选、准备和执行回执、配置验证结果，以及本次执行的健康检查 / 自动回滚程序。原 Go 二进制摘要为 `f27b5f9e9cb3bcc4462209427135a4fa76cad4a98a75585cf0e53fe1f827b152`；原 Caddy 配置摘要为 `c662fa514af3ace2afddee5e7ed41527581fbc803ef2562aa988e22de4ef2016`。原件和候选均保留。

## 公网 Node fetch 读回

使用 Node 22.23.2 的真实 `fetch` 下载公网文件并计算收到的完整响应体摘要，没有使用 curl 的成功结果替代此检查。

| 北京时间（UTC+8） | 文件 | HTTP | 字节数 | 摘要匹配 | 缓存头 |
| --- | --- | ---: | ---: | --- | --- |
| 2026-11-23 21:12:20.971 | CLI | 200 | 1,211,557 | 是 | `no-store` |
| 2026-11-23 21:12:20.971 | 初版 Windows 验收程序 | 200 | 148,467 | 是 | `no-store` |
| 2026-11-23 21:19:44.348 | Windows 验收程序 v2 | 200 | 148,479 | 是 | `no-store` |
| 2026-11-23 21:24:52.998 | stable.json | 200 | 222 | 是 | `no-store` |
| 2026-11-23 21:24:52.998 | stable.json 指向的 CLI | 200 | 1,211,557 | 是 | `no-store` |

稳定清单于北京时间 2026-11-23 21:23:49（UTC+8）通过 `fsync` 后原子改名发布。发布前检查确认没有既有清单，因此本次没有可备份的旧清单。[公开稳定清单](https://relay.cyjin.dev/updates/device/stable.json) 的 `schemaVersion=1`、`version=0.1.7`、`minNodeVersion=22.5.0`，URL 指向上述固定 CLI，`sha256` 与该 CLI 一致。完整清单本身的 SHA-256 为 `655c344a882ff6969dc91e719d4ef3eb72a630adfe7494bfe09963119e6323f4`。

## 发布门与设备迁移

- [x] **TypeScript、92 项单元测试及完整包检查通过。**
- [x] **Go 测试、静态构建、生产健康检查通过。**
- [x] **版本化 CLI 与两代 Windows 验收程序已上传并通过公网摘要校验。**
- [x] **Windows runner 的 v2 验收通过。** 直接执行已构建文件的 10 项原生 Windows 用例全部通过，PowerShell 5.1 语法检查通过；runner 没有重新构建 CLI。
- [x] **稳定清单已原子发布。** 真实公网 Node fetch 已核对清单字段、清单摘要及其引用的完整 CLI 摘要。
- [ ] **设备首次迁移使用各设备的独立验收回执。** 对已有持久 kernel 状态应延期切换，保留状态及在途任务；不能由生产服务发布成功推断所有设备已更新。

既有持久 kernel 的保护已用只读服务端审计核实：一台待迁移设备在旧 worker 本生命周期边界内有 9 次成功 `kernel_eval`、2 次失败 `kernel_eval`、0 次 `kernel_reset`，因此保留原 worker。统计只读取工具名、状态、计数及首末时间；没有读取参数或 kernel 内容。审计记录在 RPC 返回后写入，未持久化真正的在途 worker 任务数，此数量记录为未知。

首次 Linux 迁移出现一次已回退的误启动：初版迁移检查未覆盖实机的 `node-MainThread` 与 `run-doesvm.sh` 进程名，额外启动了 managed 实例。回退已停止该新实例并禁用 managed 服务和迁移 watcher；原 launcher、原 worker 的 PID 和启动时刻 ticks 保持不变，原启动脚本恢复至 SHA-256 `12bae04946e7e5759e135724bb6c744c82e4792eea3991e83126e8998019025f`。修订后的识别逻辑在实机只读 dry-run 中正确识别旧进程并返回 `canMigrate=false`，没有发送信号。额外实例中发生过自动更新，但不计为安全迁移完成；继续保护旧 worker，待确认安全退出后再迁移。身份、回退和 dry-run 回执为 `.tmp/doesvm-migration-incident.json`。

对首次切换检查的限定窗口 `[2026-11-23T13:27:00Z, 2026-11-23T13:30:00Z)` 另作只读查询，两种 kernel 工具的已完成审计记录合计为 0，回执为 `.tmp/doesvm-kernel-audit-cutover-window.json`。此结果仅限该窗口内已写入的设备级完成记录，不区分 worker PID，也不能证明不存在未完成调用。

构建和运行原始回执位于本次工作树的 `.tmp/validation-3*`、`.tmp/test-3.log`、`.tmp/build-3.log`、`.tmp/packaged-smoke-1.log`、`.tmp/go-validation-1*`、`.tmp/production-stage-receipt.json`、`.tmp/production-apply-receipt.json`、`.tmp/production-node-fetch.json`、`.tmp/windows-harness-v2-public.json`、`.tmp/stable-publication.json`、`.tmp/stable-public-node.json` 和 `.tmp/doesvm-kernel-audit.json`。本文件保留可公开的命令、版本、摘要和结果，不包含凭据、请求参数、kernel 内容或私有网络地址。
## Android 实机迁移与 OTA 验收（追加）

2026-11-23 的 Android/Termux 设备已完成首次迁移和真实在线升级。有限 detached 事务先返回排程回执，最早执行时间为 **13:33:18.572Z**；切换前再次核对旧 launcher/worker 的 PID、start ticks、真实 executable、argv、配置摘要和 tmux 单 pane，保存原脚本与完整私有启动环境。旧 worker 没有活动子任务时才进行精确 SIGTERM 交接。

| 实机证据 | 已验证结果 |
| --- | --- |
| 正式更新源 | Android 自己经 Node HTTPS 获取 stable manifest 和 CLI，HTTP 200；最终 SHA-256 为 `fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda` |
| 原版本 | `0.1.6` |
| 真实 bootstrap 前态 | **13:33:23.824Z** 观察到 `0.1.7-bootstrap.1` / `starting` |
| OTA 完成 | **13:33:40.992Z**，worker `0.1.7`、supervisor `0.1.7`、phase `running`，`previousVersion=0.1.7-bootstrap.1`；实际 worker 文件摘要与正式 CLI 一致 |
| 原身份与配置 | 原 device identity 保持；配置 SHA-256 前后完全一致，未输出或替换 token |
| 启动环境 | 原 Termux/Android 启动环境的 11 个相关变量逐项保持；环境原值只留在设备私有 mode-0600 文件 |
| 真实工具验收 | **13:34:40.279Z**，通过 My Devices 调用 `bash` 返回 exit 0；再次核对版本、两代关系、CLI 摘要、配置摘要与实际工作目录 |
| shell 子进程环境 | 实际 Bash 子进程确认 10 项变量存在：`PREFIX`、`HOME`、`ANDROID_DATA`、`ANDROID_ROOT`、`ANDROID_RUNTIME_ROOT`、`ANDROID_ART_ROOT`、`ANDROID_I18N_ROOT`、`ANDROID_TZDATA_ROOT`、`BOOTCLASSPATH`、`DEX2OATBOOTCLASSPATH` |
| 持续运行 | 保留原 tmux session `relay` 和 `~/.mcp-relay/run-tablet.sh` 入口；新 launcher 使用正式 manifest，自动检查间隔 300 秒 |

设备上的私有证据位于 `~/.mcp-relay/staging/ota-fc1bf1088fb7/cutover-2026-11-23T13-31-54-010Z-3300ffcb/`：`scheduled.json` 记录排程与 job PID，`receipt.json` 记录实际 OTA/配置/环境校验，`external-tool-acceptance.json` 记录真实 Bash 调用。原 launcher 备份与失败回滚材料保留；完整环境和私有 plan 不进入 Git。

可复用的事务、私有 plan 准备和排程工具位于 [`deploy/android/`](../deploy/android/README.md)。本节只确认 Android 已完成迁移；Windows 离线设备和 Linux 活动 kernel 的后续状态应分别以各自的现场回执判断。

## 最终设备状态与自动接续

以下区分已经运行的版本与尚未具备首次迁移条件的设备。

| 设备 | 已核验状态 | 后续动作 |
| --- | --- | --- |
| Android / localhost | 正式 0.1.7 已运行，worker 和 supervisor 同版；bootstrap → stable、SHA、配置、身份和真实 bash 调用通过 | 约每 5 分钟检查稳定通道，按 drain / readiness / rollback 流程更新 |
| doesvm | 旧 worker 与 kernel 仍在；修订迁移 watcher 为 active / enabled，新 managed relay 为 inactive / disabled | 等旧 worker 自然退出，并确认观察到的任务后代退出后，自动迁移至稳定版本 |
| TB14P-EZRA | 笔电仍离线；2026-11-23 21:32:34（UTC+8）有界安装尝试返回 75，原因是既有 SSH 不可达，未安装 | 条件任务在恢复可连接后执行同机原生验收，再执行有回滚保护的安装及真实工具验收 |

doesvm 修订程序完整摘要为 `d59044513f78551d733aae0bfc4a1c14e236979f86cc382c24e0c0e86a1ec730`。北京时间 21:37:31 和 21:37:36 两次现场快照均确认：旧 launcher/worker 的 PID 与启动 ticks 保持、原入口 SHA 保持、`canMigrate=false`、`waiting-for-legacy-exit`，且新 managed relay 没有运行。后代身份已持久保存。该程序经 14 项开发容器回归测试，额外采用实机进程识别 dry-run；完整最终回执为 `.tmp/doesvm-watcher-enabled.json`。

Windows 的单次安装工作有 720 秒上限和设备互斥锁，SSH、身份或权限阻碍不会触发自动提权、主机信任变更或其他进程的终止。首次离线回执位于 `.tmp/windows-deployment/20261123T133229Z-33277891de/attempt-receipt.json`，准确调用参数保留在私有 `.tmp/windows-deployment/invocation.json`，没有发布网络地址或凭据。

已建立每小时的条件接续任务，首次检查设为 **2026-11-23 22:35，Asia/Shanghai**。该任务仅在实际进展或新阻碍时通知，完成全部设备的安装和验收后停止；它与已迁移客户端自身约 5 分钟一次的更新轮询是两个不同步骤。不能将定时任务已建立等同于离线笔电已完成安装。

当前设备使用 HTTPS 发行通道。本轮环境没有 npm 发布凭据，因此没有声称已将 0.1.7 发布至 npm registry；旧 npm 入口仍需通过上述首次迁移流程接入受管更新。

复用 Android 事务脚本的最后一项检查补齐了 tmux pane 的 PID、启动时间、可执行文件和参数身份校验：不匹配时保留证据并延后回滚，不能把被复用的 PID 当作受管进程。CT102 直接加载修改前后的生产函数，重现旧误识别，再验证正常路径及 7 种身份变化均按预期处理；没有发送进程信号或重新部署设备。相关回执为 `.tmp/android-pane-identity-check.json`，核心 CLI 与已成功的 Android 实机事务未变化。
