#!/usr/bin/env python3
"""Stage and run the one-time doesvm migration without interrupting a legacy worker.

This watcher deliberately does not infer kernel emptiness from incomplete logs.
It waits for each observed legacy worker to exit naturally, then migrates only
when no worker or observed task descendant remains. It never signals a worker.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

SERVICE = "mcp-relay-doesvm.service"
WATCHER = "mcp-relay-doesvm-migration.service"
REQUIRED = ("launcher.cjs", "doesvm-service.env", "doesvm-run.original.sh",
            "doesvm-before.json", "mcp-relay-doesvm.service", "rollback-doesvm.py")
DIGEST = re.compile(r"^[a-f0-9]{64}$")
KEEP_RUNNING = True


def sha(data):
    return hashlib.sha256(data).hexdigest()


def atomic(path, data, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".incoming." + uuid.uuid4().hex)
    with tmp.open("xb") as stream:
        os.chmod(tmp, mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)


def immutable(path, data, mode=0o600):
    path = Path(path)
    if path.exists():
        if path.read_bytes() != data:
            raise RuntimeError("existing staged file differs: " + path.name)
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("xb") as stream:
        os.chmod(path, mode)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def bus_env(observation):
    env = dict(os.environ)
    env["XDG_RUNTIME_DIR"] = observation["runtimeDirectory"]
    env["DBUS_SESSION_BUS_ADDRESS"] = observation["dbusAddress"]
    return env


def call(argv, env=None, timeout=30, check=True):
    result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        # Commands can mention paths but never contain config contents or tokens.
        raise RuntimeError(Path(argv[0]).name + " failed (exit " + str(result.returncode) + ")")
    return result


def unit_state(env, unit=SERVICE):
    result = call(["systemctl", "--user", "show", unit, "-p", "ActiveState", "--value"], env, check=False)
    return result.stdout.strip()


def load_plan(stage):
    stage = Path(stage).resolve(strict=True)
    plan = json.loads((stage / "migration-plan.json").read_text())
    if plan.get("schemaVersion") != 1 or plan.get("device") != "doesvm-3f08":
        raise RuntimeError("invalid doesvm migration plan")
    if os.getuid() != plan["uid"]:
        raise RuntimeError("run as the recorded relay user")
    for name, digest in plan["files"].items():
        if Path(name).name != name or not DIGEST.fullmatch(digest):
            raise RuntimeError("invalid staged file receipt")
        if sha((stage / name).read_bytes()) != digest:
            raise RuntimeError("staged file integrity check failed: " + name)
    observation = json.loads((stage / "doesvm-before.json").read_text())
    if observation["uid"] != os.getuid() or observation["device"] != plan["device"]:
        raise RuntimeError("wrong device observation")
    if sha((stage / "doesvm-run.original.sh").read_bytes()) != observation["legacyLauncherSha256"]:
        raise RuntimeError("legacy snapshot integrity check failed")
    return stage, plan, observation


def state_path():
    return Path.home() / ".mcp-relay" / "migration-doesvm" / "state.json"


def record(phase, **details):
    value = {"schemaVersion": 1, "phase": phase, "updatedAt": stamp(), **details}
    atomic(state_path(), encoded(value))
    print(json.dumps(value, sort_keys=True), flush=True)
    return value


def stage_files(args):
    prepared = Path(args.prepared).resolve(strict=True)
    receipt = json.loads((prepared / "bootstrap-provenance.json").read_text())
    if not DIGEST.fullmatch(args.sha256) or not DIGEST.fullmatch(args.bootstrap_sha256):
        raise RuntimeError("expected SHA256 arguments must be lowercase full digests")
    if receipt["baseSha256"] != args.sha256 or receipt["bootstrapSha256"] != args.bootstrap_sha256:
        raise RuntimeError("approved hashes differ from bootstrap provenance")
    if receipt["bootstrapVersion"] != receipt["baseVersion"] + "-bootstrap.1":
        raise RuntimeError("unexpected bootstrap version")
    original = json.loads((prepared / "doesvm-before.json").read_text())
    if original["device"] != "doesvm-3f08" or original["uid"] != os.getuid():
        raise RuntimeError("stage must run as the doesvm relay user")
    source = Path(__file__).resolve().read_bytes()
    target = Path.home() / ".mcp-relay" / "staging" / ("doesvm-" + args.sha256[:12] + "-" + sha(source)[:12])
    files = {}
    for name in REQUIRED:
        data = (prepared / name).read_bytes()
        if sha(data) != receipt["files"][name]["sha256"]:
            raise RuntimeError("prepared digest mismatch: " + name)
        immutable(target / name, data, 0o700 if name.endswith(".py") else 0o600)
        files[name] = sha(data)
    immutable(target / "install-doesvm.py", source, 0o700)
    files["install-doesvm.py"] = sha(source)
    provenance = (prepared / "bootstrap-provenance.json").read_bytes()
    immutable(target / "bootstrap-provenance.json", provenance)
    files["bootstrap-provenance.json"] = sha(provenance)
    plan = {
        "schemaVersion": 1, "device": "doesvm-3f08", "uid": os.getuid(),
        "version": receipt["baseVersion"], "sha256": args.sha256,
        "bootstrapVersion": receipt["bootstrapVersion"],
        "bootstrapSha256": args.bootstrap_sha256,
        "manifestUrl": receipt["manifestUrl"], "files": files,
        "condition": "legacy workers exit naturally; no observed task descendants remain; trusted stable release is available",
    }
    immutable(target / "migration-plan.json", encoded(plan))
    print(json.dumps({"phase": "staged", "stage": str(target), "version": plan["version"],
                      "sha256": plan["sha256"], "watcher": WATCHER,
                      "activeLauncherChanged": False, "workerSignalled": False}, sort_keys=True))


def replace_with_backup(target, data, stage, expected=None):
    target = Path(target)
    if target.is_symlink():
        raise RuntimeError("refusing to replace a symlink: " + target.name)
    if target.exists():
        previous = target.read_bytes()
        if previous == data:
            return
        if expected is not None and sha(previous) != expected:
            raise RuntimeError("live file changed since observation: " + target.name)
        history = stage / "previous-files"
        history.mkdir(parents=True, exist_ok=True, mode=0o700)
        immutable(history / (target.name + "." + sha(previous)), previous)
    atomic(target, data, 0o700 if target.suffix == ".sh" else 0o600)


def install_watcher(args):
    stage, plan, observation = load_plan(args.stage)
    # Paths with whitespace are escaped for systemd, not interpolated into a shell.
    def quoted(value):
        return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%") + '"'
    unit = (
        "[Unit]\nDescription=Deferred My Devices migration for doesvm\n\n"
        "[Service]\nType=simple\n"
        "ExecStart=/usr/bin/python3 " + quoted(stage / "install-doesvm.py") + " watch --stage " + quoted(stage) + "\n"
        "Restart=on-failure\nRestartSec=15\nTimeoutStopSec=15\n"
        "UMask=0077\n\n[Install]\nWantedBy=default.target\n"
    ).encode()
    target = Path.home() / ".config/systemd/user" / WATCHER
    replace_with_backup(target, unit, stage)
    env = bus_env(observation)
    call(["systemctl", "--user", "daemon-reload"], env)
    call(["systemctl", "--user", "enable", WATCHER], env)
    record("watcher-enabled-not-started", stage=str(stage), version=plan["version"],
           sha256=plan["sha256"], reason="waiting for explicit service start; no relay process was changed")
    print(json.dumps({"startCommand": "systemctl --user start " + WATCHER,
                      "state": str(state_path()), "unit": str(target)}))


def process_table():
    result = {}
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            owner = path.stat().st_uid
            raw = (path / "stat").read_text()
            fields = raw.rsplit(") ", 1)[1].split()
            result[int(path.name)] = {
                "pid": int(path.name), "ppid": int(fields[1]), "uid": owner,
                "startTimeTicks": fields[19], "state": fields[0],
                "comm": raw[raw.find("(") + 1:raw.rfind(")")],
            }
        except (OSError, ValueError, IndexError):
            continue
    return result


def argv_of(pid):
    try:
        return [x.decode(errors="replace") for x in (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0") if x]
    except OSError:
        return []


def classify(table, observation, stage):
    workers, launchers = [], []
    legacy_scripts = {observation["legacyLauncher"], str(stage / "doesvm-run.original.sh")}
    config = os.path.realpath(observation["config"])
    for entry in table.values():
        if entry.get("uid", os.getuid()) != os.getuid() or entry["state"] == "Z":
            continue
        argv = argv_of(entry["pid"])
        if len(argv) > 1 and Path(argv[0]).name in ("sh", "bash", "dash") and argv[1] in legacy_scripts:
            launchers.append(entry)
            continue
        candidate = None
        for index, value in enumerate(argv):
            if value == "--config" and index + 1 < len(argv):
                candidate = argv[index + 1]
            elif value.startswith("--config="):
                candidate = value[len("--config="):]
        if "connect" in argv and candidate and os.path.realpath(candidate) == config:
            workers.append(entry)
    classified = {item["pid"] for item in workers + launchers}
    for expected in observation.get("processes", []):
        entry = table.get(expected["pid"])
        if entry is not None:
            if same_process(table, expected) and expected["pid"] not in classified:
                # The observed process still exists even if argv is unreadable or
                # unexpectedly changed. Unknown means protected, never idle.
                workers.append({**entry, "classification": "unclassified-observed-process"})
        else:
            try:
                (Path("/proc") / str(expected["pid"])).stat()
            except FileNotFoundError:
                continue
            # Permission/other errors propagate and prevent migration.
            workers.append({**expected, "ppid": -1, "state": "?", "comm": "",
                            "classification": "observed-process-missing-from-scan"})
    return workers, launchers


def same_process(table, identity):
    entry = table.get(identity["pid"])
    return bool(entry and entry["startTimeTicks"] == identity["startTimeTicks"] and entry["state"] != "Z")


def public_identity(entry):
    return {"pid": entry["pid"], "startTimeTicks": entry["startTimeTicks"]}


def descendants(table, ancestors):
    found = set(ancestors)
    changed = True
    while changed:
        changed = False
        for pid, entry in table.items():
            if entry["ppid"] in found and pid not in found:
                found.add(pid)
                changed = True
    return {pid: public_identity(table[pid]) for pid in found - set(ancestors)}


def origin(url):
    value = urllib.parse.urlsplit(url)
    if value.scheme != "https" or not value.hostname or value.username or value.password:
        raise RuntimeError("update URL must be HTTPS without credentials")
    return (value.scheme, value.hostname.lower(), value.port or 443)


class SameOrigin(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if origin(req.full_url) != origin(newurl):
            raise RuntimeError("cross-origin manifest redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def stable_target(plan):
    source = plan["manifestUrl"]
    origin(source)
    opener = urllib.request.build_opener(SameOrigin())
    request = urllib.request.Request(source, headers={"Cache-Control": "no-cache", "User-Agent": "mcp-relay-migration/1"})
    with opener.open(request, timeout=10) as response:
        raw = response.read(65537)
    if len(raw) > 65536:
        raise RuntimeError("manifest exceeds size limit")
    value = json.loads(raw)
    if value.get("schemaVersion") != 1 or not DIGEST.fullmatch(str(value.get("sha256", ""))):
        raise RuntimeError("invalid stable manifest")
    if origin(value.get("url", "")) != origin(source):
        raise RuntimeError("stable artifact is not on the trusted origin")
    # A delayed migration can consume a later approved stable version.
    stable = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", str(value.get("version", "")))
    minimum = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", plan["version"])
    if not stable or not minimum or tuple(map(int, stable.groups())) < tuple(map(int, minimum.groups())):
        raise RuntimeError("stable is older than the staged migration")
    if value["version"] == plan["version"] and value["sha256"] != plan["sha256"]:
        raise RuntimeError("stable digest differs from the approved final build")
    return {"version": value["version"], "sha256": value["sha256"]}


def update_state(observation):
    config = Path(observation["config"]).resolve()
    key = sha(str(config).encode())[:16]
    path = config.parent / "updates" / key / "state.json"
    try:
        value = json.loads(path.read_text())
        return {
            "phase": value.get("phase"),
            "version": value.get("current", {}).get("version"),
            "sha256": value.get("current", {}).get("sha256"),
            "previousVersion": value.get("previous", {}).get("version"),
            "supervisorVersion": value.get("supervisorVersion"),
            "lastResult": value.get("lastResult"), "updatedAt": value.get("updatedAt"),
        }
    except (OSError, ValueError, TypeError):
        return None


def managed_health(table, workers, env, status):
    """Require a fresh handshake journal and the actual current process generation."""
    props = call(["systemctl", "--user", "show", SERVICE, "-p", "MainPID",
                  "-p", "ExecMainStartTimestampMonotonic"], env).stdout
    values = dict(line.split("=", 1) for line in props.splitlines() if "=" in line)
    main = int(values.get("MainPID", "0"))
    if main not in table or table[main]["state"] == "Z":
        return {"ready": False, "reason": "managed launcher is absent"}
    generation = descendants(table, [main])
    generation[main] = public_identity(table[main])
    if any(item["pid"] not in generation for item in workers):
        return {"ready": False, "reason": "another config process remains outside the managed generation"}
    roles = {"launcher": [], "supervisor": [], "worker": []}
    for entry in workers:
        try:
            selected = {}
            for part in (Path("/proc") / str(entry["pid"]) / "environ").read_bytes().split(b"\0"):
                name, _, value = part.partition(b"=")
                if name in (b"MCP_RELAY_WORKER", b"MCP_RELAY_SUPERVISOR"):
                    selected[name] = value
        except OSError:
            return {"ready": False, "reason": "process role is not observable"}
        role = "worker" if selected.get(b"MCP_RELAY_WORKER") == b"1" else \
               "supervisor" if selected.get(b"MCP_RELAY_SUPERVISOR") == b"1" else "launcher"
        roles[role].append(entry)
    if any(len(entries) != 1 for entries in roles.values()):
        return {"ready": False, "reason": "expected exactly one launcher, supervisor and worker"}
    launcher, supervisor, worker = (roles[key][0] for key in ("launcher", "supervisor", "worker"))
    if launcher["pid"] != main or supervisor["ppid"] != main or worker["ppid"] != supervisor["pid"]:
        return {"ready": False, "reason": "managed process parentage differs from the expected generation"}
    realtime_offset_ms = (time.time_ns() - time.clock_gettime_ns(time.CLOCK_MONOTONIC)) / 1_000_000
    started_ms = int(realtime_offset_ms + int(values.get("ExecMainStartTimestampMonotonic", "0")) / 1000)
    if not status or not isinstance(status.get("updatedAt"), (int, float)) or status["updatedAt"] < started_ms:
        return {"ready": False, "reason": "update journal predates this service generation"}
    if status["phase"] != "running" or status["version"] != status["supervisorVersion"]:
        return {"ready": False, "reason": "the current worker and supervisor have not completed readiness"}
    return {"ready": True, "serviceStartedAtMs": started_ms,
            "processes": {key: public_identity(entries[0]) for key, entries in roles.items()}}


def managed_wrapper(observation):
    return (
        "#!/bin/sh\n# The legacy while-loop has been migrated; use the single managed instance.\n"
        "set -eu\n"
        "export XDG_RUNTIME_DIR=" + observation["runtimeDirectory"] + "\n"
        "export DBUS_SESSION_BUS_ADDRESS=" + observation["dbusAddress"] + "\n"
        "exec systemctl --user start " + SERVICE + "\n"
    ).encode()


def prepare_managed(stage, observation, env):
    home = Path.home()
    replace_with_backup(home / ".local/share/mcp-relay/launcher.cjs", (stage / "launcher.cjs").read_bytes(), stage)
    replace_with_backup(home / ".mcp-relay/doesvm-service.env", (stage / "doesvm-service.env").read_bytes(), stage)
    replace_with_backup(home / ".config/systemd/user" / SERVICE, (stage / "mcp-relay-doesvm.service").read_bytes(), stage)
    wrapper = managed_wrapper(observation)
    live = Path(observation["legacyLauncher"])
    if live.exists() and live.read_bytes() != wrapper:
        replace_with_backup(live, wrapper, stage, expected=observation["legacyLauncherSha256"])
    elif not live.exists():
        replace_with_backup(live, wrapper, stage)
    call(["systemctl", "--user", "daemon-reload"], env)
    call(["systemctl", "--user", "enable", SERVICE], env)
    call(["systemctl", "--user", "start", SERVICE], env)


def rollback(stage, observation, env):
    # Called only when the managed unit is inactive/failed and no config worker
    # remains. Never stop a worker merely because network readiness is delayed.
    table = process_table()
    workers, _ = classify(table, observation, stage)
    if workers or unit_state(env) not in ("", "inactive", "failed"):
        raise RuntimeError("managed runtime may still be active; rollback postponed")
    live = Path(observation["legacyLauncher"])
    if live.exists() and live.read_bytes() == managed_wrapper(observation):
        replace_with_backup(live, (stage / "doesvm-run.original.sh").read_bytes(), stage)
    result = call(["/usr/bin/python3", str(stage / "rollback-doesvm.py"),
                   "--observation", str(stage / "doesvm-before.json"),
                   "--original", str(stage / "doesvm-run.original.sh")], env, timeout=60)
    record("rolled-back", stage=str(stage), reason="managed service failed before accepting work",
           rollback=json.loads(result.stdout.splitlines()[-1]))


def stop_empty_launcher(launcher, observation, stage, env):
    # Two process scans and identity checks narrow the legacy two-second restart
    # window. A racing successor is protected by the next scan and is never killed.
    table = process_table()
    workers, _ = classify(table, observation, stage)
    if workers or not same_process(table, launcher):
        return False
    socket = observation["tmux"]["socket"]
    pane = observation["tmux"]["pane"]
    probe = call(["tmux", "-S", socket, "display-message", "-p", "-t", pane, "#{pane_pid}"], env, check=False)
    if probe.returncode == 0 and probe.stdout.strip() == str(launcher["pid"]):
        call(["tmux", "-S", socket, "set-option", "-p", "-t", pane, "remain-on-exit", "on"], env)
    table = process_table()
    workers, _ = classify(table, observation, stage)
    if workers or not same_process(table, launcher):
        return False
    # pidfd pins the exact process even if PID reuse occurs after the last scan.
    try:
        descriptor = os.pidfd_open(launcher["pid"])
    except ProcessLookupError:
        return False
    try:
        if not same_process(process_table(), launcher):
            return False
        try:
            signal.pidfd_send_signal(descriptor, signal.SIGTERM)
        except ProcessLookupError:
            return False
    finally:
        os.close(descriptor)
    return True


def watch(args):
    stage, plan, observation = load_plan(args.stage)
    env = bus_env(observation)
    lockpath = state_path().with_name("watcher.lock")
    lockpath.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with lockpath.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        watch_locked(stage, plan, observation, env)


def load_protected(stage):
    path = state_path().with_name("protected.json")
    boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    try:
        value = json.loads(path.read_text())
        if value.get("bootId") != boot or value.get("stage") != str(stage):
            return {}
        return {int(item["pid"]): {"pid": int(item["pid"]), "startTimeTicks": str(item["startTimeTicks"])}
                for item in value.get("processes", [])}
    except (OSError, ValueError, TypeError, KeyError):
        return {}


def save_protected(stage, protected):
    path = state_path().with_name("protected.json")
    value = {"schemaVersion": 1, "stage": str(stage),
             "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
             "processes": sorted(protected.values(), key=lambda item: item["pid"])}
    data = encoded(value)
    try:
        if path.read_bytes() == data:
            return
    except FileNotFoundError:
        pass
    atomic(path, data)


def watch_locked(stage, plan, observation, env):
    protected = load_protected(stage)
    target = None
    next_manifest_check = 0.0
    last_key = None
    last_record = 0.0
    managed_started = False
    while KEEP_RUNNING:
        now = time.monotonic()
        table = process_table()
        workers, launchers = classify(table, observation, stage)
        service = unit_state(env)
        status = update_state(observation)
        if service == "active":
            managed_started = True
            health = managed_health(table, workers, env, status)
            if health["ready"]:
                if target is None or now >= next_manifest_check:
                    try:
                        target = stable_target(plan)
                    except Exception:
                        pass
                    next_manifest_check = now + 60
                if target and status["version"] == target["version"] and status["sha256"] == target["sha256"]:
                    record("installed", stage=str(stage), service=SERVICE, version=status["version"],
                           supervisorVersion=status["supervisorVersion"], sha256=status["sha256"],
                           previousVersion=status["previousVersion"], health=health, workerSignalled=False)
                    return
            key = ("managed-awaiting-verified-update", status["phase"] if status else "not-ready",
                   status["version"] if status else None)
            if key != last_key or now - last_record >= 60:
                record(key[0], stage=str(stage), target=target, update=status, service=SERVICE, health=health,
                       reason="managed relay owns its update; network delay or kernel state must not cause forced rollback")
                last_key, last_record = key, now
            time.sleep(2)
            continue
        if managed_started and service in ("", "inactive", "failed") and not workers:
            rollback(stage, observation, env)
            return
        if workers:
            protected = {pid: item for pid, item in protected.items() if same_process(table, item)}
            protected.update(descendants(table, [item["pid"] for item in workers]))
            save_protected(stage, protected)
            # Cache release readiness before the two-second legacy respawn gap.
            # Failure leaves the running worker untouched and retries later.
            if now >= next_manifest_check:
                try:
                    target = stable_target(plan)
                except Exception:
                    target = None
                next_manifest_check = now + 60
            identities = [public_identity(item) for item in workers]
            key = ("waiting-for-legacy-exit", tuple((x["pid"], x["startTimeTicks"]) for x in identities))
            if key != last_key or now - last_record >= 60:
                record(key[0], stage=str(stage), version=plan["version"], sha256=plan["sha256"],
                       protectedWorkers=identities, reason="legacy kernel state is retained; no worker signal or reset is permitted",
                       activeLauncherChanged=False)
                last_key, last_record = key, now
            # Keep inspecting the process tree even before stable publication.
            time.sleep(0.5)
            continue
        protected = {pid: item for pid, item in protected.items() if same_process(table, item)}
        save_protected(stage, protected)
        if protected:
            key = ("waiting-for-observed-task-exit",)
            if key != last_key or now - last_record >= 60:
                record(key[0], stage=str(stage), processes=list(protected.values()),
                       reason="the legacy worker exited; observed descendants remain protected")
                last_key, last_record = key, now
            time.sleep(0.5)
            continue
        if target is None or now >= next_manifest_check:
            try:
                target = stable_target(plan)
            except Exception as error:
                key = ("waiting-for-stable-release", type(error).__name__)
                if key != last_key or now - last_record >= 60:
                    record(key[0], stage=str(stage), version=plan["version"], sha256=plan["sha256"],
                           reason="trusted stable manifest is unavailable or does not match the approved release")
                    last_key, last_record = key, now
                time.sleep(10)
                continue
            next_manifest_check = now + 60
        if launchers:
            for launcher in launchers:
                stop_empty_launcher(launcher, observation, stage, env)
            time.sleep(0.5)
            continue
        # Final check before installation: no process using the same config may
        # overlap the new launcher, including any legacy loop that raced a poll.
        table = process_table()
        workers, launchers = classify(table, observation, stage)
        if workers or launchers:
            continue
        record("starting-managed-service", stage=str(stage), target=target,
               reason="legacy workers exited naturally; no observed task or legacy launcher remains")
        try:
            prepare_managed(stage, observation, env)
            managed_started = True
        except Exception as error:
            service = unit_state(env)
            workers, _ = classify(process_table(), observation, stage)
            if service in ("", "inactive", "failed") and not workers:
                rollback(stage, observation, env)
                return
            record("managed-start-needs-observation", stage=str(stage), error=type(error).__name__,
                   reason="a runtime exists; preserve it while collecting health")
            managed_started = True
        time.sleep(2)


def verify(args):
    stage, plan, observation = load_plan(args.stage)
    env = bus_env(observation)
    table = process_table()
    workers, launchers = classify(table, observation, stage)
    try:
        migration = json.loads(state_path().read_text())
    except (OSError, ValueError):
        migration = {"phase": "not-started"}
    print(json.dumps({"migration": migration, "service": unit_state(env),
                      "watcher": unit_state(env, WATCHER), "update": update_state(observation),
                      "configProcesses": [public_identity(x) for x in workers],
                      "legacyLaunchers": [public_identity(x) for x in launchers],
                      "health": managed_health(table, workers, env, update_state(observation)) if unit_state(env) == "active" else None,
                      "stagedVersion": plan["version"], "stagedSha256": plan["sha256"]}, sort_keys=True))


def stop_requested(_signum, _frame):
    global KEEP_RUNNING
    KEEP_RUNNING = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest="action", required=True)
    staged = actions.add_parser("stage")
    staged.add_argument("--prepared", required=True)
    staged.add_argument("--sha256", required=True)
    staged.add_argument("--bootstrap-sha256", required=True)
    for name in ("enable", "watch", "verify"):
        part = actions.add_parser(name)
        part.add_argument("--stage", required=True)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop_requested)
    signal.signal(signal.SIGINT, stop_requested)
    {"stage": stage_files, "enable": install_watcher, "watch": watch, "verify": verify}[args.action](args)


if __name__ == "__main__":
    main()
