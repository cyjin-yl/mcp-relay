# 设备首次迁移运行手册（2026-11-23）

稳定 manifest：https://relay.cyjin.dev/updates/device/stable.json 。后续在线更新默认每 300 秒检查；已有任务先排空，持久 kernel 有状态时延期。所有配置与 token 沿用原文件。

## 冻结材料

工作树：/tank/shared/projects/mcp-relay/.tmp/relay-win-update-20261123
准备目录：工作树内 .tmp/deploy-stage/ready-fc1bf1088fb7/

| 文件 / 版本 | SHA256 |
| --- | --- |
| 正式 standalone 0.1.7 | fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda |
| 内部 bootstrap 0.1.7-bootstrap.1 | 54d2162bc32cfc25278d68ac30cd16cb0612e8adec71b742de8eff7837058a43 |
| install-doesvm.py | d59044513f78551d733aae0bfc4a1c14e236979f86cc382c24e0c0e86a1ec730 |
| doesvm 原入口 | 12bae04946e7e5759e135724bb6c744c82e4792eea3991e83126e8998019025f |
| Android 原入口 | 30c7db2a46f23ded84507b838da23b4ed38373d17e4d3804f93e53a0d380a8a5 |

bootstrap 只改正式 bundle 的一处 CLI VERSION；反向字节比较、摘要、Node 语法与版本核对通过。新的部署必须传入对应版本完整摘要，不能复用旧摘要。

## doesvm：持久等待已启用，尚未迁移

旧 launcher / worker 为 918033 / 918035，startTimeTicks 均为 35083571；tmux socket /tmp/tmux-1000/default，session ogd-mcp，pane %12。原入口 /home/ezra/.mcp-relay/run-doesvm.sh 与旧 worker 保持不变。旧生命周期有成功 kernel_eval、无 kernel_reset；本流程只等 worker 自然退出，不读取、序列化、清空 kernel，也不根据不完整滚动日志推断其为空。

| 项目 | 路径 / 状态 |
| --- | --- |
| 不可变迁移目录 | /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78 |
| 等待 unit | mcp-relay-doesvm-migration.service — active / enabled |
| 目标 relay unit | mcp-relay-doesvm.service — inactive / disabled |
| 状态与后代身份 | /home/ezra/.mcp-relay/migration-doesvm/state.json 和 protected.json |
| 当前阶段 | waiting-for-legacy-exit |
| 双次验收回执 | 工作树 .tmp/doesvm-watcher-enabled.json |

ezra 的 user systemd manager 已运行且 Linger=yes。watcher 可跨登出与重启接续；按 argv/config、精确 PID/start ticks 识别进程，未知已观测进程继续受保护。观察到的任务后代带 bootId 持久保存。旧 worker 自然退出、后代退出、没有同 config 继任 worker、trusted stable 可用后，才停止空闲旧循环并启动受管服务；届时原入口改为启动同一个 managed unit。

只读验收：

~~~sh
python3 /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78/install-doesvm.py verify \
  --stage /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78
~~~

13:37:31Z 与 13:37:36Z 验证均确认旧 PID/启动时间/脚本 SHA 不变、canMigrate=false、新 relay 未启动。installed 还要求当前服务代实际存在唯一 launcher→supervisor→worker、没有外部同 config 进程、ready journal 新于本次启动，并且 worker/supervisor 版本与 SHA 匹配 stable；遗留 running 状态文件不能单独证明完成。

正常准备入口如下；本次 stage、enable、start 均已执行，无需重做：

~~~sh
python3 deploy/device/install-doesvm.py stage --prepared .tmp/deploy-stage/ready-fc1bf1088fb7 \
  --sha256 fc1bf1088fb79fa8de77c60c79df601a515728eb8d2670a4a542413193f22fda \
  --bootstrap-sha256 54d2162bc32cfc25278d68ac30cd16cb0612e8adec71b742de8eff7837058a43
python3 /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78/install-doesvm.py enable \
  --stage /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78
env XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  systemctl --user start mcp-relay-doesvm-migration.service
~~~

enable 先写排程回执，不启动 relay。目标服务在接受任务前失败且不存在残留同 config 进程时，迁移程序自动调用 staged rollback；运行状态不明、网络慢或新 kernel 状态导致更新延期时保留当前进程。

## Android：真实 OTA 已通过

原入口 /data/data/com.termux/files/home/.mcp-relay/run-tablet.sh 与 tmux session relay 保留。原脚本全部 Android 环境恢复逻辑、PREFIX/PATH/MCP_RELAY_BASH、su 白名单导入、tee 日志与重试循环都保留；只修改 bundle 入口并增加 manifest/300 秒参数。

13:33:40Z 已验证 bootstrap → 0.1.7，worker 与 supervisor 同版、正式 SHA 正确、配置未变；13:34:40Z 的真实 My Devices bash 调用再次通过。事务材料位于：

/data/data/com.termux/files/home/.mcp-relay/staging/ota-fc1bf1088fb7/cutover-2026-11-23T13-31-54-010Z-3300ffcb/

receipt.json 记录 OTA，external-tool-acceptance.json 记录工具验收，scheduled.json / plan.json 记录 detached 排程及恢复方案。私有环境快照仅保存在设备上，不进入 Git。

~~~sh
node "$HOME/.local/share/mcp-relay/launcher.cjs" update-status \
  --config "$HOME/.mcp-relay/device.json"
~~~

预期 running，version=supervisorVersion=0.1.7，previousVersion=0.1.7-bootstrap.1，SHA 为正式摘要。同一入口的 update-check --config 可立即请求检查，无需改 launcher 间隔。

## 回滚、纠正记录与测试

doesvm 手动回滚入口如下；当前仅在等待，无需回滚。手工使用前协调已有任务完成。

~~~sh
python3 /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78/rollback-doesvm.py \
  --observation /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78/doesvm-before.json \
  --original /home/ezra/.mcp-relay/staging/doesvm-fc1bf1088fb7-d59044513f78/doesvm-run.original.sh
~~~

回滚仅停止指定 managed unit、归档启用链接，复核同 config 进程后复用原 tmux pane 或建立独立回滚 session；旧实例存在时不重复启动。原脚本、历史材料和凭据均保留。

首次 watcher 按 comm 名白名单判断，漏认 node-MainThread / run-doesvm.sh，曾误起第二个 relay。13:29:13Z 已停止新实例并恢复旧入口；旧 PID/start ticks 未变，kernel 所在 worker 未被信号或 reset。误起期间虽发生 OTA，不计作 doesvm 安全迁移完成。纠正记录见工作树 .tmp/doesvm-migration-incident.json；只使用上述 d590445... 程序，不重新启用旧 stage 的 watcher。

14 个迁移回归测试位于 deploy/device/test_install_doesvm.py，覆盖实际 comm 名、已观测未知 PID 保护、PID 复用、重启竞态、后代 checkpoint、旧 journal 拒绝、网络延迟保留进程和 manifest 校验。均在开发容器通过：

~~~sh
sudo -n /usr/sbin/pct exec 102 -- docker exec -w /workspace relay-build-20261123 \
  python3 deploy/device/test_install_doesvm.py
~~~
