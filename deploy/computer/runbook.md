# Computer use 0.1.11：受管设备启用与验收

本手册供已有授权的部署任务使用。目标是让已有支持 OTA 的受管设备经正常更新升到 0.1.11，再启用 computer pack；不重新配对，不替换设备凭据，不清空 kernel。发布、设备在线、版本就绪、功能启用、实际工具验收是不同状态，必须分别记录。

适用于 Linux（包括 PVE 宿主上的本机 QEMU VM）、Windows、macOS，以及已有授权 `su` 的 Android。平台能力和限制见 [computer-use.md](../../docs/computer-use.md)，OTA 恢复约定见 [WINDOWS_AND_UPDATES.md](../../docs/WINDOWS_AND_UPDATES.md)。Android 桥和自有测试界面见 [Android input README](../../packages/android-input/README.md)。

## 1. 准备发布与已有设备入口

发布者先完成最终源码验证和平台原生验收，固定版本化 CLI、SHA-256 和对应 harness，再发布版本化文件，最后原子更新受信 HTTPS stable manifest。具体流程见 [0.1.11 verification and publication](../../docs/VERIFICATION_20261124_0_1_11.md)。验收记录中的摘要必须来自最终发布回执，不能沿用早期 CI 候选的摘要。设备 updater 会验证 HTTPS 同源、下载摘要、Node 语法、导入、版本和认证注册；Node 需至少 22.5。

每台设备的部署任务记录以下非秘密信息：

- 设备 ID/slug、预期平台、实际正在使用的绝对 config 路径。
- 现有服务/launcher 的所有者与入口、原有环境恢复方式、已受管或仍等待首次迁移。
- 已批准目标版本和最终 CLI SHA-256、观察时间、当前步骤及延期原因。
- 真实工具调用验收时间和结果；Android APK/harness 摘要及本地证据位置。

不要记录 token、配对码、config 正文、用户输入文本或 PNG base64。保留原 launcher/Termux 环境；不要另起一个同身份 worker 来“试一下”。

**管理命令必须用新版 CLI。** OTA 后旧 bootstrap/launcher 文件仍可能显示旧版本；它的 `connect` 可以选择新版 supervisor，但旧文件并不会把 `computer-enable` 等新子命令转发给新版。使用已验证的 0.1.11 bundle 的绝对路径，并先确认：

```sh
node /absolute/path/to/verified-0.1.11/cli.cjs --version
node /absolute/path/to/verified-0.1.11/cli.cjs update-status --config /absolute/path/to/device.json
```

下面所有 `CLI` 均指这个新版文件，`CONFIG` 指同一设备实际使用的 config。Windows 可在 PowerShell 中使用绝对路径调用 `node.exe`，参数含义相同。

如部署程序只有 config 路径，可在设备本地按以下只读算法定位已安装 current；它只打印经摘要复核的入口，不打印凭据。保存代码为受部署任务管理的临时脚本后以 `node locate-current.cjs <absolute-config>` 执行：

```js
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = fs.realpathSync(path.resolve(process.argv[2]));
const identity = process.platform === "win32" ? config.toLowerCase() : config;
const suffix = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
const stateDir = path.join(path.dirname(config), "updates", suffix);
const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
const current = state.current;
if (state.schemaVersion !== 1 || !current || !path.isAbsolute(current.entryPoint)
    || !/^[a-f0-9]{64}$/.test(current.sha256)) {
  throw new Error("No valid managed release record; keep this device pending.");
}
const actual = crypto.createHash("sha256")
  .update(fs.readFileSync(current.entryPoint)).digest("hex");
if (actual !== current.sha256) throw new Error("Installed current digest mismatch.");
process.stdout.write(JSON.stringify({
  version: current.version, supervisorVersion: state.supervisorVersion,
  phase: state.phase, sha256: actual, cli: current.entryPoint
}) + "\n");
```

摘要匹配仅证明本地入口与 journal 一致；还须与本次已批准发布回执相符。journal 的 `running` 可在崩溃后残留，不能单凭它判定设备当前在线或新 generation 已接单。

## 2. 让已有 supervisor 完成正常 OTA

已有在线 supervisor 默认每五分钟加抖动检查更新；可以用其支持的命令唤醒一次：

```sh
node "$CLI" update-check --config "$CONFIG"
node "$CLI" update-status --config "$CONFIG"
```

观察 `version=0.1.11`、`supervisorVersion=0.1.11`、目标 SHA、`phase=running`，再核对一次新的设备注册或真实工具回调。短暂断线属于最终切换过程；不要因为 WebSocket 刚重连便断言热更新通过。

遇到以下状态保留任务并等待：

| 条件 | 自动流程应做什么 |
| --- | --- |
| 设备离线 | 保留持久队列项和最终发布摘要；设备恢复后继续读取状态。离线设备不能记为已安装。 |
| 正在执行工具或等待结果发送完成 | 原 supervisor 会延期并恢复接单；稍后按正常周期重试，不强杀任务。 |
| 受管 worker 有 persistent kernel 状态 | 保留状态和延期原因。只有调用者确实完成会话并有意执行 `kernel_reset`，或 worker 自然结束，才允许后续安全切换；迁移任务不自行 reset。 |
| 旧版未受管 worker 保留 kernel | 继续使用已有持久迁移等待器，按其已核验的精确进程身份等待自然退出；不要启动竞争连接或套用新版 reload 协议。 |
| candidate 未就绪、摘要错误或启动失败 | 读取失败/回退原因，保留已验证旧版；遵守失败摘要冷却，不循环强制重试。 |
| 暂无交互桌面、已锁屏、权限未知或不足 | 记录 blocked/unknown。不要模拟解锁、自动接受权限或改变系统授权策略。 |

已在 0.1.7 supervisor 上排队的 `update-check` 仍有用；**本地 safe reload 从 0.1.8 supervisor 起可用**。若先用已验证的新 CLI 写了 enable sidecar，0.1.7 supervisor 不会自行理解 reload 文件；之后正常 OTA 启动的 0.1.11 worker 会读取 sidecar，新的 supervisor 会消费启动前已有的请求。

## 3. 启用 sidecar，并等待 safe reload

确认新版已经运行后，对该 config 执行一次：

```sh
node "$CLI" computer-enable --config "$CONFIG"
node "$CLI" computer-status --config "$CONFIG"
node "$CLI" update-status --config "$CONFIG"
```

`computer-enable` 会：

1. 原子写入 config 旁的 `.computer.json`，不改凭据文件。
2. 写本地 worker reload 请求，并唤醒一次正常更新检查。
3. 返回 `workerReloadRequested: true`，表示请求已排队，**不表示新工具已注册**。

监督器在下一轮读取请求，对现 worker 排空，再以当前已验证 bundle 启动暂停的 replacement；认证注册及稳定窗口通过后才打开接单。这个本地 reload 不下载 bundle、不改变 current/previous/failed 发布历史，也不为了同版本 reload 重启 supervisor。原有版本 OTA 检查仍照常运行。

监控 `update-status.reload`：

| reload.status | 含义及接续 |
| --- | --- |
| pending | 请求已保存，或激活通道待确认。继续只读轮询。 |
| deferred | active work/kernel 阻止切换，原 worker 继续服务；保留请求，supervisor 按更新周期再试。 |
| completed | 新 worker 已加载这次请求并就绪/激活；继续做实际工具注册验收。 |
| failed | replacement 未通过或控制失败，已尝试恢复可信入口；记录原因。排除原因后才发新的显式请求。 |

无 supervisor 或显式 `--no-auto-update` 时，sidecar 等到下一次受管启动才会加载；不能报告为在线 reload 完成。

sidecar 在 enabled/paused 实际变化时生成新的 revision；无变化的写入保留 revision。未完成且 revision 相同的请求合并；变化后的新 revision 必须产生新请求，即使设置经历 true→false→true 后有效值又相同，也不能被较早 candidate 的 ready 吞掉。

**轮询循环调用 status，不要不断执行 computer-enable**：前一次已 completed/failed 后再次 enable 会创建新的 reload 请求。队列项应保存已发出的请求 ID；重连后继续观察该 ID，避免重复重启。

`computer-enable` 保留原 `paused` 值，不会撤销已有的本地暂停。如果用户明确要恢复控制，再执行：

```sh
node "$CLI" computer-resume --config "$CONFIG"
```

后来的本地 pause/disable 具有优先级；自动接续任务不能反复覆盖它。

## 4. 验证实际工具注册

用 My Devices 对**同一设备 ID/slug**刷新工具列表，或通过现有服务接口调用 tools/list。必须看到：

```text
computer_info
computer_screenshot
computer_action
computer_handoff
computer_setup
```

客户端缓存未更新时，使用 `device_tools_list` 后按设备 ID 进行原始 `device_call`；不要以全局工具列表中残留的名称作为该设备已注册的证据。验收首先调用：

```json
{"device":"<target-device-id>","tool":"computer_info","arguments":{}}
```

记录响应中的 `enabled`、`paused`、backend、generation、availability、permissions、displays 和支持的 actions，以及这次回调的时间。该响应来自实时 worker，不能用磁盘上遗留的 journal 替代。工具已注册但 OS 不可用时，分别记录“registered”与“blocked”，不要记为原生输入通过。

截图通过 `computer_screenshot` 返回原生 PNG image block，并附 frame_id、尺寸和截图像素坐标信息；文本工具回执中有一个 URL 或 base64 字符串不算该项验收。只在用户授权的当前界面或部署自有测试界面做截图/动作验证。

每次动作使用最新 frame_id 和新的 request_id；动作消耗先前帧。display、旋转或前台 app 变化后重新观察。超时或 `mayHaveApplied` 时先观察，不能自动重放文本、点击或按键。

## 5. PVE：选择 VM 控制台并验收

在 PVE 宿主的同一设备身份启用 computer pack 后，先调用 `computer_info` 查看本机 VM 清单和各目标当前的可用性。用 `display_id: "pve:<VMID>"` 选择目标，例如：

```json
{"device":"<pve-host-device-id>","tool":"computer_info","arguments":{"display_id":"pve:123"}}
```

随后对同一 `display_id` 调用 `computer_screenshot`，核对截图来自预期 VM 的 QEMU 虚拟显示器。在动作中只传新截图的 `frame_id`、新的 `request_id` 和 `action`；不另传 `display_id`。帧已绑定 VM 和其运行实例，VM 重启后即使 VMID 相同也必须重新观察。跨 VM 验收分别使用各自的新帧，不能复用另一台的帧。

该接口捕获虚拟控制台，不代表 GPU 直通给客体的物理屏幕。LXC 容器不是 QEMU VM 显示目标。PVE 的文本输入依赖 US 键盘布局，`unicodeText` 为 `false`；中文或 emoji 不能记作输入通过。可用动作以目标实时返回的 capabilities 为准。

PVE 滚动仅支持 `up`、`down`；`left`、`right` 会明确返回 `unsupported_action`。验收应核对客体实际收到的滚轮事件，不能只把 QMP 成功回执当作水平滚动已生效。此限制仅针对 PVE backend，不改变其他平台的滚动能力。

原生输入验收使用部署自有 VM/测试界面，核对截图、点击、按键及支持的文本输入结果，保留目标 VMID、实例标识和最终 bundle/harness 摘要。生产 VM 的清单可见性和 fixture 的实际输入通过分别记录。宿主已有任务或 kernel 阻止升级时，保留原延期状态，不为 PVE 能力绕过安全更新流程。

临时分享选择的是 PVE **宿主设备**，并非其中某台 VM。只读分享可观察其已启用的可用控制台；操作分享可向这些控制台输入，包括之后新增 VM 的控制台。当前没有分享级的 VM 子集限制。

## 6. Android：显式安装自有输入桥

保留已有 Termux launcher 中 PREFIX、PATH、MCP_RELAY_BASH 和 Android runtime 环境恢复逻辑。先用 `computer_info` 确认 touch/screen、当前 app、root/输入能力与锁屏状态；info 不安装 APK。首次 su 授权可能出现系统提示，relay 不会替用户确认。

在本次已授权部署中，明确执行一次以下任一入口：

```json
{"device":"<android-device-id>","tool":"computer_setup","arguments":{"timeout_ms":120000}}
```

或设备本地：

```sh
node "$CLI" computer-setup --config "$CONFIG"
```

setup 安装当前 standalone bundle 内嵌的第一方签名 APK，并核对 embedded/installed SHA-256。它不卸载其他应用、不修改 su 策略、不打开无障碍开关，不需要另找第三方 APK。之后再调 computer_info，确认桥已安装。中文/emoji 使用 InputConnection.commitText，不把 `input text` 当作 Unicode 实现。

每次 text 动作临时选择本桥，带独立请求 ID 和确认回执，完成或失败后恢复原 selected/enabled IME 状态。清理失败或结果不确定要报告 `mayHaveApplied`，不能重放。已有本地暂停必须先由用户明确恢复，setup 不应绕过它。

### 只用自有 ProbeActivity 做原生验收

由开发容器构建并核对最终 harness 摘要。真机运行入口如下，输出目录必须是新的私有目录：

```sh
node /absolute/path/to/verified/android-computer-smoke.cjs \
  --out "$HOME/.mcp-relay/computer-test-<unique-run-id>"
```

输入桥已通过上一节安装和摘要核对时，验收不再传 `--setup`。harness 仅启动 `dev.cyjin.mcprelay.input/.ProbeActivity`。每次 action 前后核对自有前台 Activity；截图前、捕获 metadata 和捕获后观察都通过才落盘。焦点未知或切走即失败停止，不能把另一个 app 的图像保存为测试证据。不要在验收进行中切换应用。

验收包括中文、emoji、换行的精确 UTF-8 字节数/摘要，自有文本框 Backspace、自有按钮 tap、自有 pad drag、自有 scroll view 滚动，以及 selected/enabled IME 的最终一致性。BACK 清理只在自有 Activity 仍为前台时发送；回执据实际后续焦点报告是否已关闭。

PNG 仅保存在该设备本地 0700 证据目录中的 0600 文件，不写 stdout、不上传到其他服务、不加入 Git。例行汇总只包含断言结果、文件名/摘要、尺寸和状态。harness 的构建/签名检查、单测通过、原生 CI 和这台 Android 真机通过是独立结论。

harness 直接验证本机 backend；**它不能替代第 4 节对实际 relay 注册及 MCP 回调的验收**。

## 7. 自动接续的持久任务与完成条件

将上述流程作为现有持久迁移/部署任务的一部分，按以下状态接续；本文件不自行创建任何后台任务：

状态依次为 `waiting-online`、`waiting-version`、`enable-requested`、`waiting-reload`、`waiting-platform-setup`、`verifying-registration` 和 `accepted`。任何一步遇到已知阻碍，保存对应的 pending/deferred/blocked 原因后在同一步接续。

任务执行者必须已有重启后仍可恢复的队列/服务/定时器，且每次变更后保存回执。设备离线时只重试连接及状态读取；在线后复用同一 config/设备身份。首次 enable、显式 Android setup 和无副作用的状态检查可以按本手册完成，不能把用户原来授权的部署误变成反复 UI 输入。UI 动作和不确定的 text 结果不进入自动重试队列。

延期状态至少保存：目标版本/摘要、当前版本、请求 ID（已有时）、pending/deferred/blocked 原因、最后一次观察、下次检查时间，以及负责接续的已启用服务/任务标识。不存在实际已启用执行者时，只能写“prepared”，不能宣称已安排自动接续。

每台设备仅在以下证据齐全后标 accepted：

- 当前 worker 和 supervisor 为已批准版本/摘要，且有新 generation 的实时回调。
- computer pack 的五个工具确实注册，computer_info 与预期平台相符。
- 所需系统能力可用；Android setup 和自有 UI 验收成功；平台受限时准确保留 blocked。
- 已验证截图 image block/坐标与至少一次在自有测试界面的实际动作。
- 凭据/设备身份未改变，原有环境恢复入口仍有效；无竞争 worker。
- 后续 OTA supervisor 持续受管，默认检查周期仍在；离线/旧 kernel 设备保持真实 pending 状态。

## 8. 暂停、禁用与故障处理

```sh
node "$CLI" computer-pause --config "$CONFIG"
node "$CLI" computer-disable --config "$CONFIG"
```

pause 阻止动作并允许观察；disable 也禁止截图。正在执行的 native 动作遵循取消及有界清理，不能承诺指令发出瞬间所有 OS 副作用消失。这些命令不删除 APK、不改配对、不清 kernel，不应为关闭 computer 功能而强杀整个 relay。

版本 candidate 失败交由现有 updater 恢复可信版本；本地 reload 失败保留发布回滚历史。若发现已发布回归，停止推广并按正常发布流程修复，不手工篡改 journal、不跳过摘要检查、不反复重放最后一次 UI 动作。所有既有证据和回执保留，不删除以“重试干净”。
