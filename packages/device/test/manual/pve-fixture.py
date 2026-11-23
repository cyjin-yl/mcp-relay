#!/usr/bin/env python3
"""Create/observe/remove only an explicitly owned, diskless PVE QA VM.

Run as root on the PVE host. The directory must be on a filesystem with space,
not a full /tmp. This script never starts or sends input to an existing VM.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

VMID = 990190
NAME = "mcp-relay-cua-qa-019"
QM = "/usr/sbin/qm"
PVESH = "/usr/bin/pvesh"


def run(args, *, env=None, timeout=45):
    result = subprocess.run(args, capture_output=True, text=True, env=env, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(args[0]).name} {args[1]} failed: {result.stderr.strip()[:1500]}")
    return result.stdout.strip()


def inventory():
    rows = json.loads(run([PVESH, "get", "/nodes/localhost/qemu", "--output-format", "json"]))
    return {str(row["vmid"]): {key: row.get(key) for key in ("name", "status", "pid")}
            for row in rows if row["vmid"] != VMID}


def save(path, value):
    temporary = path.with_name(path.name + ".writing")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(temporary, 0o644)
    temporary.replace(path)


def process_identity(pid):
    try:
        return Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()[19]
    except (OSError, IndexError):
        return None


def append_cpio(output, name, mode, data=b"", inode=1):
    encoded = name.encode() + b"\0"
    fields = [inode, mode, 0, 0, 1, 0, len(data), 0, 0, 0, 0, len(encoded), 0]
    header = b"070701" + b"".join(f"{value:08x}".encode() for value in fields)
    output.write(header + encoded)
    output.write(b"\0" * (-(len(header) + len(encoded)) % 4))
    output.write(data)
    output.write(b"\0" * (-len(data) % 4))


def build(base):
    rootfs = base / "rootfs"
    rootfs.mkdir()
    for name in ("bin", "lib", "lib64", "dev", "proc", "sys", "tmp", "run", "modules"):
        (rootfs / name).mkdir()
    os.chmod(rootfs / "tmp", 0o1777)
    env = dict(os.environ, TMPDIR=str(base / "tmp"))
    source = Path(__file__).with_name("pve-fixture.c")
    run(["gcc", "-O2", "-static", "-Wall", "-Wextra", "-Werror", str(source),
         "-o", str(rootfs / "fixture")], env=env)
    shutil.copyfile("/usr/bin/busybox", rootfs / "bin/busybox")
    os.chmod(rootfs / "bin/busybox", 0o755)
    for library in sorted(set(re.findall(r"(/[^\s()]+)", run(["ldd", "/usr/bin/busybox"])))):
        destination = rootfs / library.lstrip("/")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(library, destination)
        os.chmod(destination, 0o755)
    modules = []
    for name in ("hid_generic", "usbhid", "psmouse", "uhci-hcd", "ehci-pci", "xhci-pci", "bochs"):
        for line in run(["/usr/sbin/modprobe", "--show-depends", name]).splitlines():
            if line.startswith("insmod "):
                path = line.split()[1]
                if path not in modules:
                    modules.append(path)
    commands = []
    for index, source_module in enumerate(modules):
        destination = rootfs / "modules" / f"{index}.ko"
        shutil.copyfile(source_module, destination)
        commands.append(f"/bin/busybox insmod /modules/{index}.ko")
    init = "\n".join([
        "#!/bin/busybox sh", "export PATH=/bin", "/bin/busybox mount -t proc proc /proc",
        "/bin/busybox mount -t sysfs sysfs /sys", "/bin/busybox mount -t devtmpfs devtmpfs /dev",
        "echo 0 > /proc/sys/kernel/printk", *commands, "exec /fixture", "",
    ])
    (rootfs / "init").write_text(init)
    os.chmod(rootfs / "init", 0o755)
    archive = base / "fixture-initramfs.cpio.gz"
    with archive.open("wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as output:
        for index, path in enumerate([rootfs, *sorted(rootfs.rglob("*"))], 1):
            name = str(path.relative_to(rootfs))
            info = path.stat()
            append_cpio(output, name, info.st_mode, path.read_bytes() if path.is_file() else b"", index)
        append_cpio(output, "TRAILER!!!", 0)
    return archive


def verify_owned(base):
    marker = json.loads((base / "owner.json").read_text())
    if marker.get("vmid") != VMID or marker.get("name") != NAME or not marker.get("created_vm"):
        raise RuntimeError("No valid owned-VM creation receipt; refusing to act")
    config = run([QM, "config", str(VMID), "--current", "1"])
    values = dict(line.split(": ", 1) for line in config.splitlines() if ": " in line)
    if values.get("name") != NAME or values.get("description") != marker["description"]:
        raise RuntimeError("VM ownership marker changed; refusing to act")
    if any(re.fullmatch(r"(?:ide|sata|scsi|virtio|net)\d+", key) for key in values):
        raise RuntimeError("Fixture unexpectedly gained a disk or network device; refusing to act")
    return marker


def wait_ui(base, previous_boot=None):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            value = json.loads((base / "state.json").read_text())
            if value.get("bootId") and value["bootId"] != previous_boot and value.get("devices", 0) >= 2:
                return value
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError("The owned guest did not produce a fresh boot receipt")


def create(base):
    if base.exists():
        raise RuntimeError("Use a new fixture directory; existing paths are never overwritten")
    if json.loads(run([PVESH, "get", "/cluster/nextid", "--vmid", str(VMID), "--output-format", "json"])) != str(VMID):
        raise RuntimeError("Fixture VMID is occupied")
    if shutil.disk_usage(base.parent).free < 256 * 1024 * 1024:
        raise RuntimeError("Fixture filesystem has less than 256 MiB free")
    base.mkdir(mode=0o755)
    (base / "tmp").mkdir(mode=0o1777)
    marker = {"vmid": VMID, "name": NAME, "description": "mcp-relay-owned-qa-" + uuid.uuid4().hex,
              "created_at": time.time(), "created_vm": False, "before_vms": inventory()}
    save(base / "owner.json", marker)
    archive = build(base)
    kernel = Path("/boot/vmlinuz-" + os.uname().release)
    marker.update({"kernel": str(kernel), "kernel_sha256": hashlib.sha256(kernel.read_bytes()).hexdigest(),
                   "initrd_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(), "initrd_bytes": archive.stat().st_size})
    # Recheck immediately before the only VM creation operation.
    if json.loads(run([PVESH, "get", "/cluster/nextid", "--vmid", str(VMID), "--output-format", "json"])) != str(VMID):
        raise RuntimeError("Fixture VMID became occupied while building")
    qemu_args = shlex.join(["-kernel", str(kernel), "-initrd", str(archive), "-append",
                            "console=tty1 console=ttyS0,115200 quiet loglevel=0 panic=-1"])
    env = dict(os.environ, TMPDIR=str(base / "tmp"))
    run([QM, "create", str(VMID), "--name", NAME, "--description", marker["description"],
         "--memory", "384", "--cores", "1", "--sockets", "1", "--balloon", "0", "--onboot", "0",
         "--bios", "seabios", "--machine", "pc", "--vga", "std", "--tablet", "1", "--serial0", "socket",
         "--ostype", "l26", "--agent", "0", "--args", qemu_args], env=env)
    marker["created_vm"] = True
    save(base / "owner.json", marker)
    verify_owned(base)
    run([QM, "start", str(VMID)], env=env)
    with (base / "observer.log").open("ab") as log:
        observer = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "observe", str(base)],
                                    stdout=log, stderr=log, start_new_session=True, env=env)
    marker.update({"observer_pid": observer.pid, "observer_start_ticks": process_identity(observer.pid)})
    save(base / "owner.json", marker)
    wait_ui(base)
    print(json.dumps({"created": True, "vmid": VMID, "directory": str(base), "initrd_bytes": marker["initrd_bytes"]}))


def observe(base):
    verify_owned(base)
    deadline = time.monotonic() + 1800
    while time.monotonic() < deadline:
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(2)
                connection.connect(f"/run/qemu-server/{VMID}.serial0")
                pending = b""
                while time.monotonic() < deadline:
                    try:
                        chunk = connection.recv(4096)
                    except socket.timeout:
                        continue
                    if not chunk:
                        break
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        if b"PVE_QA_STATE " not in line:
                            continue
                        value = json.loads(line.split(b"PVE_QA_STATE ", 1)[1])
                        if value.get("fixture") == NAME and value.get("vmid") == VMID:
                            value["observed_at"] = time.time()
                            save(base / "state.json", value)
                    pending = pending[-8192:]
        except (OSError, ValueError):
            time.sleep(0.25)


def remove(base):
    marker = verify_owned(base)
    pid = marker.get("observer_pid")
    if pid and process_identity(pid) == marker.get("observer_start_ticks"):
        os.kill(pid, signal.SIGTERM)
    run([QM, "stop", str(VMID), "--timeout", "15"])
    verify_owned(base)
    run([QM, "destroy", str(VMID)])
    after = inventory()
    unchanged = after == marker["before_vms"]
    marker.update({"created_vm": False, "removed_at": time.time(), "existing_vms_unchanged": unchanged})
    save(base / "owner.json", marker)
    save(base / "cleanup.json", {"removed": True, "vmid": VMID, "existing_vms_unchanged": unchanged,
                                "before": marker["before_vms"], "after": after})
    # Preserve small receipts and observed screenshots; remove only our boot artifacts.
    shutil.rmtree(base / "rootfs")
    shutil.rmtree(base / "tmp")
    (base / "fixture-initramfs.cpio.gz").unlink()
    print(json.dumps({"removed": True, "vmid": VMID, "existing_vms_unchanged": unchanged}))


def rebuild(base):
    """Rebuild only the already-owned fixture's initramfs after a UI change."""
    marker = verify_owned(base)
    previous_boot = None
    if (base / "state.json").exists():
        previous_boot = json.loads((base / "state.json").read_text()).get("bootId")
    run([QM, "stop", str(VMID), "--timeout", "15"])
    shutil.rmtree(base / "rootfs")
    (base / "fixture-initramfs.cpio.gz").unlink()
    archive = build(base)
    marker.update({"initrd_sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                   "initrd_bytes": archive.stat().st_size})
    save(base / "owner.json", marker)
    run([QM, "start", str(VMID)], env=dict(os.environ, TMPDIR=str(base / "tmp")))
    wait_ui(base, previous_boot)
    print(json.dumps({"rebuilt": True, "vmid": VMID, "initrd_bytes": archive.stat().st_size}))


def keyboard_usb(base):
    """Add a standard USB keyboard to this owned VM only, then reboot its UI."""
    marker = verify_owned(base)
    config = run([QM, "config", str(VMID), "--current", "1"])
    values = dict(line.split(": ", 1) for line in config.splitlines() if ": " in line)
    arguments = shlex.split(values.get("args", ""))
    device = "usb-kbd,id=relayqa-keyboard"
    if device not in arguments:
        arguments.extend(["-device", device])
        run([QM, "set", str(VMID), "--args", shlex.join(arguments)])
    marker["keyboard_variant"] = "usb"
    save(base / "owner.json", marker)
    rebuild(base)


def restart_observer(base):
    """Restart the bounded own serial observer without changing VM state."""
    marker = verify_owned(base)
    old = marker.get("observer_pid")
    if old and process_identity(old) == marker.get("observer_start_ticks"):
        os.kill(old, signal.SIGTERM)
    before = time.time()
    with (base / "observer.log").open("ab") as log:
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "observe", str(base)],
                                 stdout=log, stderr=log, start_new_session=True,
                                 env=dict(os.environ, TMPDIR=str(base / "tmp")))
    marker.update({"observer_pid": child.pid, "observer_start_ticks": process_identity(child.pid)})
    save(base / "owner.json", marker)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            if json.loads((base / "state.json").read_text())["observed_at"] > before:
                print(json.dumps({"observer_restarted": True, "vmid": VMID, "remaining_seconds": 1800}))
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.1)
    raise RuntimeError("The restarted own observer did not receive a fresh guest heartbeat")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("create", "observe", "rebuild", "keyboard-usb", "restart-observer", "remove"))
    parser.add_argument("directory", type=Path)
    arguments = parser.parse_args()
    if os.geteuid() != 0:
        parser.error("Run this deliberate manual fixture command as root or sudo -n")
    directory = arguments.directory.resolve()
    {"create": create, "observe": observe, "rebuild": rebuild, "keyboard-usb": keyboard_usb,
     "restart-observer": restart_observer, "remove": remove}[arguments.operation](directory)
