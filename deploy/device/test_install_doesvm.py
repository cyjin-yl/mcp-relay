"""Pure process/manifest tests; no live processes or services are changed."""
import json
from pathlib import Path
import types
import unittest
from unittest.mock import Mock, patch

SOURCE = Path(__file__).with_name("install-doesvm.py")
M = types.ModuleType("migration_under_test")
M.__file__ = str(SOURCE)
exec(compile(SOURCE.read_text(), str(SOURCE), "exec"), M.__dict__)

WORKER = {"pid": 200, "ppid": 100, "startTimeTicks": "30", "state": "S", "comm": "node"}
LOOP = {"pid": 100, "ppid": 10, "startTimeTicks": "20", "state": "S", "comm": "sh"}
TASK = {"pid": 300, "ppid": 200, "startTimeTicks": "40", "state": "S", "comm": "sleep"}
PLAN = {"version": "0.1.7", "sha256": "a" * 64, "manifestUrl": "https://relay.example/updates/device/stable.json"}
OBS = {"tmux": {"socket": "/tmp/example", "pane": "%12"}}


class MigrationTests(unittest.TestCase):
    def setUp(self):
        M.KEEP_RUNNING = True
        self.patchers = [patch.object(M, "load_protected", return_value={}), patch.object(M, "save_protected"),
                         patch.object(M, "managed_health", return_value={"ready": True})]
        for item in self.patchers:
            item.start()
            self.addCleanup(item.stop)

    def test_stale_journal_cannot_verify_a_new_live_service_generation(self):
        # Exercise the real health function, bypassing the default watcher stub.
        self.patchers[-1].stop()
        launcher = {**LOOP, "ppid": 1}
        supervisor = {**WORKER, "ppid": 100}
        worker = {**TASK, "ppid": 200}
        environments = {
            "/proc/100/environ": b"",
            "/proc/200/environ": b"MCP_RELAY_SUPERVISOR=1\0",
            "/proc/300/environ": b"MCP_RELAY_WORKER=1\0MCP_RELAY_SUPERVISOR=1\0",
        }
        class FakePath:
            def __init__(self, path): self.path = str(path)
            def __truediv__(self, part): return FakePath(self.path + "/" + str(part))
            def read_bytes(self): return environments[self.path]
        props = types.SimpleNamespace(stdout="MainPID=100\nExecMainStartTimestampMonotonic=10000000\n")
        value = {"phase": "running", "version": "0.1.7", "supervisorVersion": "0.1.7", "updatedAt": 989000}
        with patch.object(M, "call", return_value=props), patch.object(M, "Path", FakePath), \
                patch.object(M.time, "time_ns", return_value=1_000_000_000_000), \
                patch.object(M.time, "clock_gettime_ns", return_value=20_000_000_000):
            table = {100: launcher, 200: supervisor, 300: worker}
            result = M.managed_health(table, list(table.values()), {}, value)
            self.assertFalse(result["ready"])
            self.assertIn("predates", result["reason"])
            value["updatedAt"] = 991000
            self.assertTrue(M.managed_health(table, list(table.values()), {}, value)["ready"])

    def test_real_linux_comm_names_do_not_hide_legacy_processes(self):
        old_worker = {**WORKER, "comm": "node-MainThread"}
        old_loop = {**LOOP, "comm": "run-doesvm.sh"}
        observation = {"config": "/observed/config.json", "legacyLauncher": "/observed/run-doesvm.sh",
                       "processes": [M.public_identity(old_loop), M.public_identity(old_worker)]}
        argv = {200: ["/usr/bin/node", "/legacy/cli.cjs", "connect", "--config", "/observed/config.json"],
                100: ["/bin/sh", "/observed/run-doesvm.sh"]}
        with patch.object(M, "argv_of", side_effect=lambda pid: argv[pid]):
            workers, launchers = M.classify({200: old_worker, 100: old_loop}, observation, Path("/staged"))
        self.assertEqual([item["pid"] for item in workers], [200])
        self.assertEqual([item["pid"] for item in launchers], [100])

    def test_known_live_pid_is_protected_when_argv_cannot_be_classified(self):
        observation = {"config": "/observed/config.json", "legacyLauncher": "/observed/run-doesvm.sh",
                       "processes": [M.public_identity(WORKER)]}
        with patch.object(M, "argv_of", return_value=[]):
            workers, launchers = M.classify({200: WORKER}, observation, Path("/staged"))
        self.assertEqual([item["pid"] for item in workers], [200])
        self.assertEqual(workers[0]["classification"], "unclassified-observed-process")
        self.assertEqual(launchers, [])

    def test_checkpoint_protects_orphan_after_watcher_restart(self):
        M.load_protected.return_value = {300: M.public_identity(TASK)}
        def sleep(_):
            M.KEEP_RUNNING = False
        with patch.multiple(M, process_table=Mock(return_value={300: TASK}),
                            classify=Mock(return_value=([], [LOOP])),
                            unit_state=Mock(return_value="inactive"), update_state=Mock(return_value=None),
                            record=Mock(), prepare_managed=Mock(), stop_empty_launcher=Mock()), patch.object(M.time, "sleep", sleep):
            M.watch_locked(Path("/staged"), PLAN, OBS, {})
            M.prepare_managed.assert_not_called()
            M.stop_empty_launcher.assert_not_called()
            self.assertEqual(M.record.call_args.args[0], "waiting-for-observed-task-exit")

    def test_running_legacy_worker_is_only_observed(self):
        records = []
        def sleep(_):
            M.KEEP_RUNNING = False
        with patch.multiple(M, process_table=Mock(return_value={200: WORKER}),
                            classify=Mock(return_value=([WORKER], [LOOP])),
                            unit_state=Mock(return_value="inactive"), update_state=Mock(return_value=None),
                            stable_target=Mock(return_value={"version": "0.1.7", "sha256": "a" * 64}),
                            record=Mock(side_effect=lambda phase, **kw: records.append((phase, kw))),
                            prepare_managed=Mock(), stop_empty_launcher=Mock()), patch.object(M.time, "sleep", sleep):
            M.watch_locked(Path("/staged"), PLAN, OBS, {})
            M.prepare_managed.assert_not_called()
            M.stop_empty_launcher.assert_not_called()
        self.assertEqual(records[0][0], "waiting-for-legacy-exit")
        self.assertEqual(records[0][1]["protectedWorkers"], [{"pid": 200, "startTimeTicks": "30"}])

    def test_observed_task_outlives_its_worker(self):
        records = []
        count = 0
        def sleep(_):
            nonlocal count
            count += 1
            if count == 2:
                M.KEEP_RUNNING = False
        with patch.multiple(M, process_table=Mock(side_effect=[{200: WORKER, 300: TASK}, {300: TASK}]),
                            classify=Mock(side_effect=[([WORKER], [LOOP]), ([], [LOOP])]),
                            unit_state=Mock(return_value="inactive"), update_state=Mock(return_value=None),
                            stable_target=Mock(return_value={"version": "0.1.7", "sha256": "a" * 64}),
                            record=Mock(side_effect=lambda phase, **kw: records.append((phase, kw))),
                            prepare_managed=Mock(), stop_empty_launcher=Mock()), patch.object(M.time, "sleep", sleep):
            M.watch_locked(Path("/staged"), PLAN, OBS, {})
            M.prepare_managed.assert_not_called()
            M.stop_empty_launcher.assert_not_called()
        self.assertEqual(records[-1][0], "waiting-for-observed-task-exit")
        self.assertEqual(records[-1][1]["processes"], [{"pid": 300, "startTimeTicks": "40"}])

    def test_new_worker_in_restart_window_prevents_launcher_signal(self):
        with patch.multiple(M, process_table=Mock(return_value={100: LOOP, 200: WORKER}),
                            classify=Mock(side_effect=[([], [LOOP]), ([WORKER], [LOOP])]),
                            call=Mock(return_value=types.SimpleNamespace(returncode=1, stdout=""))), \
                patch.object(M.os, "pidfd_open") as opened:
            self.assertFalse(M.stop_empty_launcher(LOOP, OBS, Path("/staged"), {}))
            opened.assert_not_called()

    def test_launcher_pid_reuse_is_not_signalled(self):
        reused = {**LOOP, "startTimeTicks": "999"}
        with patch.multiple(M, process_table=Mock(return_value={100: reused}),
                            classify=Mock(return_value=([], [reused]))), patch.object(M.os, "pidfd_open") as opened:
            self.assertFalse(M.stop_empty_launcher(LOOP, OBS, Path("/staged"), {}))
            opened.assert_not_called()

    def test_managed_network_delay_does_not_trigger_rollback(self):
        def sleep(_):
            M.KEEP_RUNNING = False
        with patch.multiple(M, process_table=Mock(return_value={200: WORKER}),
                            classify=Mock(return_value=([WORKER], [])),
                            unit_state=Mock(return_value="active"), update_state=Mock(return_value=None),
                            record=Mock(), rollback=Mock(), prepare_managed=Mock()), patch.object(M.time, "sleep", sleep):
            M.watch_locked(Path("/staged"), PLAN, OBS, {})
            M.rollback.assert_not_called()
            M.prepare_managed.assert_not_called()
            self.assertEqual(M.record.call_args.args[0], "managed-awaiting-verified-update")

    def test_verified_worker_and_supervisor_complete_migration(self):
        value = {"phase": "running", "version": "0.1.7", "supervisorVersion": "0.1.7",
                 "sha256": "a" * 64, "previousVersion": "0.1.7-bootstrap.1"}
        with patch.multiple(M, process_table=Mock(return_value={200: WORKER}),
                            classify=Mock(return_value=([WORKER], [])),
                            unit_state=Mock(return_value="active"), update_state=Mock(return_value=value),
                            stable_target=Mock(return_value={"version": "0.1.7", "sha256": "a" * 64}), record=Mock()):
            M.watch_locked(Path("/staged"), PLAN, OBS, {})
            self.assertEqual(M.record.call_args.args[0], "installed")
            self.assertEqual(M.record.call_args.kwargs["supervisorVersion"], "0.1.7")

    def target(self, version, digest, url="https://relay.example/updates/device/cli.cjs"):
        value = {"schemaVersion": 1, "version": version, "sha256": digest, "url": url}
        response = Mock()
        response.read.return_value = json.dumps(value).encode()
        context = Mock()
        context.__enter__ = Mock(return_value=response)
        context.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = context
        with patch.object(M.urllib.request, "build_opener", return_value=opener):
            return M.stable_target(PLAN)

    def test_same_version_different_digest_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "approved final"):
            self.target("0.1.7", "b" * 64)

    def test_later_trusted_stable_release_unblocks_delayed_migration(self):
        self.assertEqual(self.target("0.1.8", "b" * 64)["version"], "0.1.8")

    def test_cross_origin_artifact_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "trusted origin"):
            self.target("0.1.7", "a" * 64, "https://other.example/cli.cjs")

    def test_stale_release_is_refused(self):
        with self.assertRaisesRegex(RuntimeError, "older"):
            self.target("0.1.6", "a" * 64)


if __name__ == "__main__":
    unittest.main(verbosity=2)
