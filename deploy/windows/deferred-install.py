#!/usr/bin/env python3
"""One bounded Windows relay staging/install attempt from a trusted SSH host.

The caller supplies an existing SSH target and exact artifact digests. This is
not a scheduler: a reviewed external job may retry exit 75 until its deadline.
Without --execute it only prints the invocation plan.
"""
import argparse
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit
import uuid


class AttemptError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def ps_quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def arguments():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--mode", choices=("Stage", "Install"), default="Stage")
    parser.add_argument("--ssh-target", required=True, help="Existing trusted user@hostname or user@address")
    parser.add_argument("--expected-computer-name", required=True)
    parser.add_argument("--expected-identity", required=True, help=r"Verified COMPUTER\user")
    parser.add_argument("--bundle-sha256", required=True)
    parser.add_argument("--bootstrap-sha256", required=True)
    parser.add_argument("--harness-sha256", required=True)
    parser.add_argument("--bundle", type=Path, default=Path("release/device/0.1.7/cli.cjs"))
    parser.add_argument("--bootstrap", type=Path, required=True)
    parser.add_argument("--harness", type=Path, default=Path(".tmp/windows-bundle-smoke-v2.cjs"))
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--output-dir", type=Path, default=Path(".tmp/windows-deployment"))
    parser.add_argument("--relay-url", default="https://relay.cyjin.dev")
    parser.add_argument("--manifest-url")
    parser.add_argument("--node-path", help="Optional verified stable Windows node.exe; no fnm_multishells path")
    return parser.parse_args()


class Attempt:
    def __init__(self, args):
        self.args = args
        self.repo = args.repo.resolve()
        self.run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:10]
        output = args.output_dir if args.output_dir.is_absolute() else self.repo / args.output_dir
        self.output = output / self.run_id
        self.output.mkdir(parents=True, mode=0o700)
        self.root_output = output
        self.remote_stage = None
        self.node_path = None
        self.step = "local-validation"
        self.steps = []
        self.lock_file = None
        self.report = {
            "schemaVersion": 1, "startedAt": utc_now(), "runId": self.run_id,
            "mode": args.mode, "passed": False, "phase": self.step,
            "expectedComputerName": args.expected_computer_name,
            "expectedIdentity": args.expected_identity,
        }

    def save(self, name, value):
        path = self.output / name
        data = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        with path.open("x", encoding="utf-8") as stream:
            os.chmod(path, 0o600)
            stream.write(data)
        return path

    def header(self):
        return "\n".join([
            "$ErrorActionPreference = 'Stop'",
            "$ProgressPreference = 'SilentlyContinue'",
            "$relayEncoding = New-Object Text.UTF8Encoding($false)",
            "[Console]::InputEncoding = $relayEncoding",
            "[Console]::OutputEncoding = $relayEncoding",
            "$OutputEncoding = $relayEncoding",
            "$relayIdentity = [Security.Principal.WindowsIdentity]::GetCurrent().Name",
            "if ($env:COMPUTERNAME -ine " + ps_quote(self.args.expected_computer_name)
            + " -or $relayIdentity -ine " + ps_quote(self.args.expected_identity)
            + ") { throw 'Unexpected Windows computer/account; no deployment action performed' }",
        ]) + "\n"

    def remote(self, name, code, timeout=25, payload=None):
        self.step = name
        self.report["phase"] = name
        encoded = base64.b64encode((self.header() + code).encode("utf-16le")).decode("ascii")
        argv = [
            "ssh", "-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes",
            "-oConnectTimeout=4", "-oServerAliveInterval=10", "-oServerAliveCountMax=2",
            self.args.ssh_target,
            "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand " + encoded,
        ]
        try:
            result = subprocess.run(argv, input=payload, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise AttemptError("SSH step timed out; its remote outcome may require journal recovery", 75)
        except OSError as exc:
            raise AttemptError("SSH executable could not start: " + str(exc), 77)
        stdout = result.stdout.decode("utf-8-sig", errors="replace").strip()
        stderr = result.stderr.decode("utf-8", errors="replace")
        if result.returncode == 255:
            denied = any(term in stderr.lower() for term in (
                "host key verification failed", "remote host identification has changed",
                "permission denied", "no matching host key", "no matching key exchange",
            ))
            raise AttemptError("Existing SSH trust/authentication rejected the connection" if denied
                               else "Windows SSH is currently unavailable", 77 if denied else 75)
        try:
            value = json.loads(stdout)
        except ValueError:
            # Keep diagnostics private for operators, without including raw output in job logs.
            self.save(name + "-diagnostic.json", {
                "returnCode": result.returncode, "stdout": stdout[-16000:],
                "stderr": stderr[-16000:],
            })
            raise AttemptError("Remote step did not produce its expected JSON receipt", 77 if
                               ("PSSecurityException" in stderr or "UnauthorizedAccess" in stderr) else 1)
        self.save(name + ".json", value)
        self.steps.append({"name": name, "returnCode": result.returncode})
        if result.returncode != 0 or value.get("passed") is False:
            reason = str(value.get("error", "Remote validation or deployment failed"))
            retry = ("Another installer already owns" in reason
                     or "Existing managed relay retains ownership" in reason)
            raise AttemptError(reason, 77 if value.get("permissionDenied") else 75 if retry else 1)
        return value

    def transfer(self, name, data, expected):
        code = "\n".join([
            "$stage = " + ps_quote(self.remote_stage),
            "[IO.Directory]::CreateDirectory($stage) | Out-Null",
            "$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
            "$received = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes)).Replace('-','').ToLowerInvariant()",
            "if ($received -ne " + ps_quote(expected) + ") { throw 'Transfer payload digest mismatch' }",
            "$target = Join-Path $stage " + ps_quote(name),
            "if (Test-Path -LiteralPath $target) {",
            "  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $received) { throw 'Preserved transfer conflicts with expected digest' }",
            "} else { [IO.File]::WriteAllBytes($target,$bytes) }",
            "if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $received) { throw 'Written transfer digest mismatch' }",
            "[ordered]@{ passed=$true; file=" + ps_quote(name) + "; sha256=$received; bytes=$bytes.Length } | ConvertTo-Json -Compress",
        ])
        return self.remote("transfer-" + name.replace(".", "-"), code, timeout=45,
                           payload=base64.b64encode(data))

    def common_parameters(self):
        args = self.args
        node = ps_quote(self.node_path)
        return "\n".join([
            "$stage = " + ps_quote(self.remote_stage),
            "$parameters = @{",
            "  BundlePath = (Join-Path $stage 'cli.cjs')",
            "  ExpectedSha256 = " + ps_quote(args.bundle_sha256),
            "  BootstrapPath = (Join-Path $stage 'launcher.cjs')",
            "  BootstrapSha256 = " + ps_quote(args.bootstrap_sha256),
            "  HarnessPath = (Join-Path $stage 'windows-bundle-smoke.cjs')",
            "  HarnessSha256 = " + ps_quote(args.harness_sha256),
            "  NodePath = " + node,
            "  ExpectedComputerName = " + ps_quote(args.expected_computer_name),
            "  ExpectedIdentity = " + ps_quote(args.expected_identity),
            "  ExpectedRelayUrl = " + ps_quote(args.relay_url),
            "  ManifestUrl = " + ps_quote(args.manifest_url),
            "  RequireOtaProof = $true",
            "}",
        ]) + "\n"

    def read_receipt(self, file_name, step):
        return self.remote(step, "[IO.File]::ReadAllText((Join-Path "
                           + ps_quote(self.remote_stage) + " " + ps_quote(file_name) + "))", timeout=20)

    def run(self):
        args = self.args
        if not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.:-]+", args.ssh_target):
            raise AttemptError("Use one explicit existing user@host SSH destination", 77)
        for field in ("bundle_sha256", "bootstrap_sha256", "harness_sha256"):
            value = getattr(args, field).lower()
            if not re.fullmatch(r"[0-9a-f]{64}", value):
                raise AttemptError("All artifact SHA-256 values must contain exactly 64 hex digits", 77)
            setattr(args, field, value)
        args.relay_url = args.relay_url.rstrip("/")
        args.manifest_url = args.manifest_url or args.relay_url + "/updates/device/stable.json"
        relay, manifest = urlsplit(args.relay_url), urlsplit(args.manifest_url)
        if (relay.scheme != "https" or manifest.scheme != "https" or relay.netloc != manifest.netloc
                or relay.username or relay.password or manifest.username or manifest.password
                or relay.query or manifest.query or relay.fragment or manifest.fragment):
            raise AttemptError("Release manifest must use HTTPS on the expected credential-free relay origin", 77)
        key = sha256((args.expected_identity.lower() + "\0" + args.expected_computer_name.lower()).encode())[:20]
        self.lock_file = (self.root_output / ("attempt-" + key + ".lock")).open("a")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AttemptError("Another bounded attempt is already active for this device", 75)
        specs = [
            ("cli.cjs", args.bundle, args.bundle_sha256),
            ("launcher.cjs", args.bootstrap, args.bootstrap_sha256),
            ("windows-bundle-smoke.cjs", args.harness, args.harness_sha256),
            ("test-windows-bundle.ps1", Path("scripts/test-windows-bundle.ps1"), None),
            ("install-windows.ps1", Path("scripts/install-windows.ps1"), None),
        ]
        artifacts = []
        for name, source, expected in specs:
            source = source if source.is_absolute() else self.repo / source
            data = source.read_bytes()
            actual = sha256(data)
            if expected is not None and actual != expected:
                raise AttemptError("Local artifact digest mismatch: " + name)
            artifacts.append((name, data, actual))
        self.save("input-digests.json", [{"name": n, "sha256": d, "bytes": len(b)} for n, b, d in artifacts])
        node_expression = (ps_quote(args.node_path) if args.node_path else
                           "(Join-Path $env:APPDATA 'fnm\\node-versions\\v24.14.0\\installation\\node.exe')")
        probe = self.remote("identity", "\n".join([
            "$node = " + node_expression,
            "if ($node -match '[\\\\/]fnm_multishells[\\\\/]' -or -not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Verified stable Node executable is unavailable' }",
            "$stage = Join-Path ([IO.Path]::GetTempPath()) " + ps_quote("mcp-relay-deploy-" + self.run_id),
            "[ordered]@{ online=$true; computerName=$env:COMPUTERNAME; identity=$relayIdentity; stage=$stage; node=$node } | ConvertTo-Json -Compress",
        ]))
        self.remote_stage, self.node_path = probe["stage"], probe["node"]
        self.report["remoteStage"] = self.remote_stage
        for name, data, digest in artifacts:
            self.transfer(name, data, digest)
        stage_result = self.remote("stage", self.common_parameters() + "\n".join([
            "$parameters.Mode = 'Stage'",
            "$parameters.ReceiptPath = Join-Path $stage 'stage-receipt.json'",
            "& (Join-Path $stage 'install-windows.ps1') @parameters",
        ]), timeout=70)
        smoke = "\n".join([
            "$stage = " + ps_quote(self.remote_stage),
            "$parameters = @{",
            " BundlePath=(Join-Path $stage 'cli.cjs'); ExpectedSha256=" + ps_quote(args.bundle_sha256),
            " HarnessPath=(Join-Path $stage 'windows-bundle-smoke.cjs'); HarnessSha256=" + ps_quote(args.harness_sha256),
            " NodePath=" + ps_quote(self.node_path),
            " ExpectedComputerName=" + ps_quote(args.expected_computer_name),
            " ReceiptPath=(Join-Path $stage 'acceptance-receipt.json')",
            "}",
            "& (Join-Path $stage 'test-windows-bundle.ps1') @parameters",
        ])
        self.remote("native-smoke", smoke, timeout=120)
        self.read_receipt("acceptance-receipt.json", "acceptance-receipt")
        if args.mode == "Install":
            install_result = self.remote("install", self.common_parameters() + "\n".join([
                "$parameters.Mode = 'Install'",
                "$parameters.AcceptanceReceipt = Join-Path $stage 'acceptance-receipt.json'",
                "$parameters.ReceiptPath = Join-Path $stage 'install-receipt.json'",
                "& (Join-Path $stage 'install-windows.ps1') @parameters",
            ]), timeout=200)
            self.read_receipt("install-receipt.json", "install-receipt")
            if (install_result.get("runtimeSha256") != args.bundle_sha256
                    or install_result.get("otaProven") is not True
                    or install_result.get("configSha256") != stage_result.get("configSha256")):
                raise AttemptError("Install receipt did not prove the exact runtime, OTA transition and unchanged config")
            self.report["phase"] = install_result["phase"]
            self.report["runtimeVersion"] = install_result.get("runtimeVersion")
            self.report["supervisorVersion"] = install_result.get("supervisorVersion")
            self.report["otaProven"] = True
        else:
            self.report["phase"] = "staged-and-tested"
        self.report["configSha256"] = stage_result["configSha256"]
        self.report["bundleSha256"] = args.bundle_sha256
        self.report["bootstrapSha256"] = args.bootstrap_sha256
        self.report["harnessSha256"] = args.harness_sha256
        self.report["passed"] = True

    def finish(self, code, message=None):
        self.report["completedAt"] = utc_now()
        self.report["exitCode"] = code
        self.report["steps"] = self.steps
        if message:
            self.report["error"] = message
        receipt = self.save("attempt-receipt.json", self.report)
        print(json.dumps({"passed": self.report["passed"], "phase": self.report["phase"],
                          "exitCode": code, "receipt": str(receipt),
                          **({"error": message} if message else {})}, ensure_ascii=False))
        if self.lock_file:
            self.lock_file.close()
        return code


def main():
    args = arguments()
    if not args.execute:
        print(json.dumps({"execute": False, "mode": args.mode,
                          "sequence": ["verify local digests", "strict SSH identity", "transfer and verify",
                                       "Stage", "native loopback smoke"] + (
                                       ["Install -RequireOtaProof", "read receipts"] if args.mode == "Install" else []),
                          "instruction": "Add --execute only to run this already-reviewed bounded attempt."}, indent=2))
        return 0
    os.umask(0o077)
    attempt = Attempt(args)
    try:
        attempt.run()
        return attempt.finish(0)
    except AttemptError as exc:
        return attempt.finish(exc.code, str(exc))
    except Exception as exc:
        return attempt.finish(1, type(exc).__name__ + ": " + str(exc))


if __name__ == "__main__":
    sys.exit(main())
