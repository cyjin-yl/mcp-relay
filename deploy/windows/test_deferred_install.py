#!/usr/bin/env python3
"""Offline contract tests; never contact an SSH destination or write receipts."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("deferred_install", Path(__file__).with_name("deferred-install.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class DeferredComputerTests(unittest.TestCase):
    def args(self, *extra):
        argv = ["deferred-install.py", "--ssh-target", "fixture@fixture.invalid",
                "--expected-computer-name", "FIXTURE", "--expected-identity", r"FIXTURE\user",
                "--bundle-sha256", "a" * 64, "--bootstrap-sha256", "b" * 64,
                "--harness-sha256", "c" * 64, "--bootstrap", "fixture.cjs", *extra]
        with patch.object(helper.sys, "argv", argv):
            return helper.arguments()

    def attempt(self, add=False):
        attempt = helper.Attempt.__new__(helper.Attempt)
        attempt.args = self.args(*(("--add-computer",) if add else ()))
        attempt.args.manifest_url = "https://relay.cyjin.dev/updates/device/stable.json"
        attempt.node_path = r"C:\Node\node.exe"
        attempt.remote_stage = r"C:\fixture\stage"
        attempt.report = {"passed": False, "phase": "validation"}
        attempt.steps = []
        attempt.save = Mock()
        return attempt

    def test_default_is_off_and_forwarded_as_false(self):
        attempt = self.attempt()
        self.assertFalse(attempt.args.add_computer)
        self.assertIn("  AddComputer = $false\n", attempt.common_parameters())

    def test_explicit_opt_in_is_forwarded(self):
        attempt = self.attempt(True)
        self.assertIn("  AddComputer = $true\n", attempt.common_parameters())
        self.assertIn("  RequireOtaProof = $true\n", attempt.common_parameters())

    def test_pending_receipt_keeps_committed_installation_and_pause(self):
        attempt = self.attempt(True)
        computer = {"enabled": True, "paused": True, "complete": False, "enableInvoked": True}
        receipt = {"passed": False, "phase": "capability-pending", "installationCommitted": True,
                   "computer": computer, "error": "safe drain pending"}
        result = SimpleNamespace(returncode=1, stdout=json.dumps(receipt).encode(), stderr=b"")
        with patch.object(helper.subprocess, "run", return_value=result) as remote:
            with self.assertRaises(helper.AttemptError) as error:
                attempt.remote("install", "fixture only")
        self.assertEqual(error.exception.code, 75)
        self.assertEqual(attempt.report["phase"], "capability-pending")
        self.assertTrue(attempt.report["installationCommitted"])
        self.assertEqual(attempt.report["computer"], computer)
        self.assertEqual(remote.call_count, 1)

    def test_ordinary_failed_install_does_not_claim_commit(self):
        attempt = self.attempt(True)
        result = SimpleNamespace(returncode=1, stdout=b'{"passed":false,"phase":"failed","error":"bad hash"}', stderr=b"")
        with patch.object(helper.subprocess, "run", return_value=result):
            with self.assertRaises(helper.AttemptError) as error:
                attempt.remote("install", "fixture only")
        self.assertEqual(error.exception.code, 1)
        self.assertNotIn("installationCommitted", attempt.report)

    def receipt(self):
        return {"computer": {"requested": True, "enabled": True, "paused": True,
                "complete": True, "workerPackVerified": True, "runtimeReady": True,
                "effectivePacks": ["minimal", "omp", "computer"], "registrationVerified": False}}

    def test_local_completion_preserves_pause_without_claiming_server_discovery(self):
        receipt = self.receipt()
        self.assertIs(helper.verify_computer_activation(receipt), receipt["computer"])
        self.assertTrue(receipt["computer"]["paused"])
        self.assertFalse(receipt["computer"]["registrationVerified"])

    def test_missing_requested_pack_or_ready_proof_is_rejected(self):
        for field in ("requested", "enabled", "complete", "workerPackVerified", "runtimeReady"):
            with self.subTest(field=field):
                receipt = self.receipt()
                receipt["computer"][field] = False
                with self.assertRaises(helper.AttemptError):
                    helper.verify_computer_activation(receipt)
        receipt = self.receipt()
        receipt["computer"]["effectivePacks"] = ["minimal", "omp"]
        with self.assertRaises(helper.AttemptError):
            helper.verify_computer_activation(receipt)

    def test_missing_pause_state_is_not_accepted_as_a_complete_receipt(self):
        receipt = self.receipt()
        del receipt["computer"]["paused"]
        with self.assertRaises(helper.AttemptError):
            helper.verify_computer_activation(receipt)


if __name__ == "__main__":
    unittest.main()
