#!/usr/bin/env python3
"""Explicit doesvm rollback. Run only after the coordinator chooses to roll back."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

UNIT = "mcp-relay-doesvm.service"
ENV_KEYS = {"PATH", "SHELL", "LANG", "LC_ALL", "MCP_RELAY_BASH", "PREFIX"}

def run(args, env, check=True):
    return subprocess.run(args, env=env, text=True, capture_output=True, check=check)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--observation", required=True, help="doesvm-before.json captured before cutover")
    parser.add_argument("--original", required=True, help="verified doesvm-run.original.sh snapshot")
    args = parser.parse_args()
    metadata = json.loads(Path(args.observation).read_text())
    original = Path(args.original).resolve(strict=True)
    if metadata.get("schemaVersion") != 1 or metadata.get("device") != "doesvm-3f08":
        raise RuntimeError("observation does not describe doesvm")
    if os.getuid() != metadata["uid"]:
        raise RuntimeError("run rollback as the observed relay user, not another user or root")
    if hashlib.sha256(original.read_bytes()).hexdigest() != metadata["legacyLauncherSha256"]:
        raise RuntimeError("original launcher does not match the observed digest")
    home = Path.home()
    lock_path = home / ".mcp-relay" / "doesvm-rollback.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        env = dict(os.environ)
        env["XDG_RUNTIME_DIR"] = metadata["runtimeDirectory"]
        env["DBUS_SESSION_BUS_ADDRESS"] = metadata["dbusAddress"]
        stop = run(["systemctl", "--user", "stop", UNIT], env, check=False)
        state = run(["systemctl", "--user", "show", UNIT, "-p", "ActiveState", "--value"], env, check=False).stdout.strip()
        if state not in ("", "inactive", "failed"):
            raise RuntimeError("managed relay is not stopped; no legacy instance was started")
        if stop.returncode and state not in ("", "inactive", "failed"):
            raise RuntimeError("could not stop the managed relay")
        # Preserve enablement metadata by moving it into history instead of deleting it.
        link = home / ".config" / "systemd" / "user" / "default.target.wants" / UNIT
        expected = (home / ".config" / "systemd" / "user" / UNIT).resolve()
        if link.is_symlink():
            if link.resolve() != expected:
                raise RuntimeError("unexpected unit enablement target; not changing it")
            archive = original.parent / "rollback-history"
            archive.mkdir(mode=0o700, parents=True, exist_ok=True)
            link.rename(archive / (UNIT + ".enable-link." + uuid.uuid4().hex))
        elif link.exists():
            raise RuntimeError("unit enablement is an unexpected regular file")
        run(["systemctl", "--user", "daemon-reload"], env)

        legacy_launchers = {str(original), metadata["legacyLauncher"]}
        legacy_binary = metadata.get("legacyBinary", "")
        current = []
        for process in Path("/proc").iterdir():
            if not process.name.isdigit():
                continue
            try:
                if process.stat().st_uid != os.getuid():
                    continue
                argv = [part.decode(errors="replace") for part in (process / "cmdline").read_bytes().split(b"\0") if part]
                if len(argv) > 1 and Path(argv[0]).name in {"sh", "bash", "dash"} and argv[1] in legacy_launchers:
                    current.append({"pid": int(process.name), "kind": "legacy-launcher"})
                    continue
                config = None
                for index, part in enumerate(argv):
                    if part == "--config" and index + 1 < len(argv):
                        config = argv[index + 1]
                    elif part.startswith("--config="):
                        config = part[len("--config="):]
                if "connect" in argv and config and os.path.realpath(config) == os.path.realpath(metadata["config"]):
                    is_legacy = bool(legacy_binary and legacy_binary in argv)
                    current.append({"pid": int(process.name), "kind": "legacy-worker" if is_legacy else "other-relay"})
            except (OSError, ProcessLookupError):
                continue
        if current:
            if any(item["kind"] == "other-relay" for item in current):
                raise RuntimeError("another relay still uses this config; refusing to create a duplicate")
            print(json.dumps({"status": "legacy-already-running", "processes": current}))
            return

        socket = metadata["tmux"]["socket"]
        pane = metadata["tmux"]["pane"]
        prefix = ["tmux", "-S", socket]
        environment = []
        for key, value in metadata.get("runtimeEnvironment", {}).items():
            if key not in ENV_KEYS or not isinstance(value, str) or any(c in value for c in "\0\r\n"):
                raise RuntimeError("unexpected recorded runtime environment")
            environment.extend(["-e", key + "=" + value])
        probe = run(prefix + ["display-message", "-p", "-t", pane, "#{session_name}\t#{pane_dead}\t#{pane_start_command}"], env, check=False)
        fields = probe.stdout.strip().split("\t")
        reuse = probe.returncode == 0 and len(fields) == 3 and fields[0] == metadata["tmux"]["session"] and fields[1] == "1" and metadata["legacyLauncher"] in fields[2]
        if reuse:
            run(prefix + ["respawn-pane", "-t", pane, "-c", metadata["workingDirectory"]] + environment + ["/bin/sh", str(original)], env)
            override = metadata["tmux"].get("remainOnExit")
            if override == "":
                run(prefix + ["set-option", "-p", "-u", "-t", pane, "remain-on-exit"], env)
            elif override in ("on", "off", "failed"):
                run(prefix + ["set-option", "-p", "-t", pane, "remain-on-exit", override], env)
            target = {"pane": pane, "session": metadata["tmux"]["session"]}
        else:
            session = "relay-doesvm-rollback-" + time.strftime("%Y%m%d-%H%M%S") + "-" + str(os.getpid())
            started = run(prefix + ["new-session", "-d", "-P", "-F", "#{session_name} #{pane_id} #{pane_pid}", "-s", session, "-c", metadata["workingDirectory"]] + environment + ["/bin/sh", str(original)], env)
            target = {"session": session, "tmux": started.stdout.strip()}
        print(json.dumps({"status": "legacy-started", "target": target, "next": "verify the device reconnects through devices_list; no config or token file was changed"}))

if __name__ == "__main__":
    main()
