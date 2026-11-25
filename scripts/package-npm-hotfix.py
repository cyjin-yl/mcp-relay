#!/usr/bin/env python3
"""Package the npm-only 0.1.12-npmfix.1 hotfix without rebuilding the 0.1.11 runtime.

This copies the verified official 0.1.11 artifact and adds the npm bin shim.
It never invokes build-device.mjs or writes an OTA release or stable manifest.
The normal source package and CLI VERSION remain 0.1.11.
"""
import argparse
import base64
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile

PACKAGE_VERSION = "0.1.12-npmfix.1"
RUNTIME_VERSION = "0.1.11"
ORIGINAL_SHA256 = "e435b1cd9ed1b9d4428e5ac7d8528cf5e0859d95958a10a173f63f2c1b7e8cad"
ORIGINAL_BYTES = 276777
SHIM_SHA256 = "981250e22ebaa7d05c6144f3c578d390b434d605be5774b1c43ffcc76b1983c4"
SHIM_BYTES = 356
ORIGINAL_MEMBERS = {
    "package/dist/cli.cjs": ("8b64aba92d8e72e254c4aac0707beb32a09bad4adfe174151fa6d71c0bcab15f", 1434868, 0o755),
    "package/package.json": ("c7c32d1567fbd0b6df5ae0944e9385d7cb0b5e180023e1b465458cca5377e259", 843, 0o644),
    "package/README.md": ("a3e466de9d39774cf527df974ffd3f61a865ee2a48e5b041457d3b39a279df9f", 6909, 0o644),
}

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def require(condition, message):
    if not condition:
        raise ValueError(message)

def regular_bytes(path, expected_sha256, expected_bytes):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode), "Input must be a regular file")
        require(before.st_size == expected_bytes, "Input byte size differs from reviewed source")
        data = stream.read(expected_bytes + 1)
        after = os.fstat(stream.fileno())
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns), "Input changed while reading")
    require(len(data) == expected_bytes and sha256(data) == expected_sha256,
            "Input SHA-256 differs from reviewed source")
    return data

def package_hotfix(original_path, output):
    original = regular_bytes(original_path, ORIGINAL_SHA256, ORIGINAL_BYTES)
    shim_path = Path(__file__).resolve().parents[1] / "packages/device/bin/mcp-relay.cjs"
    shim = regular_bytes(shim_path, SHIM_SHA256, SHIM_BYTES)
    members = {}
    with tarfile.open(fileobj=io.BytesIO(original), mode="r:gz") as archive:
        items = archive.getmembers()
        require(len(items) == len(ORIGINAL_MEMBERS) and
                {item.name for item in items} == set(ORIGINAL_MEMBERS), "Original package member set differs")
        for item in items:
            digest, size, mode = ORIGINAL_MEMBERS[item.name]
            require(item.isfile() and item.size == size and item.mode == mode, "Original member metadata differs")
            stream = archive.extractfile(item)
            require(stream is not None, "Original member is unreadable")
            data = stream.read(size + 1)
            require(len(data) == size and sha256(data) == digest, "Original member bytes differ")
            members[item.name] = (data, mode)
    metadata = json.loads(members["package/package.json"][0])
    require(metadata["name"] == "@cyjin/mcp-relay" and metadata["version"] == RUNTIME_VERSION,
            "Unexpected original package identity")
    require(metadata["main"] == "./dist/cli.cjs" and
            metadata["bin"] == {"mcp-relay": "./dist/cli.cjs"}, "Unexpected original entry points")
    metadata["version"] = PACKAGE_VERSION
    metadata["bin"] = {"mcp-relay": "./bin/mcp-relay.cjs"}
    metadata["files"] = ["bin/mcp-relay.cjs", "dist/cli.cjs", "README.md"]
    members["package/package.json"] = ((json.dumps(metadata, indent=2) + "\n").encode(), 0o644)
    members["package/bin/mcp-relay.cjs"] = (shim, 0o755)

    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", filename="", mtime=0, compresslevel=9) as compressed:
        with tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, (data, mode) in sorted(members.items()):
                item = tarfile.TarInfo(name)
                item.size = len(data)
                item.mode = mode
                item.mtime = 0
                archive.addfile(item, io.BytesIO(data))
    packed = buffer.getvalue()
    require(output.name == "cyjin-mcp-relay-" + PACKAGE_VERSION + ".tgz", "Use the fixed hotfix artifact filename")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "wb") as stream:
        os.fchmod(stream.fileno(), 0o644)
        stream.write(packed)
        stream.flush()
        os.fsync(stream.fileno())
    return {
        "packageVersion": PACKAGE_VERSION, "runtimeVersion": RUNTIME_VERSION,
        "runtimeUnchanged": True, "otaManifestWritten": False,
        "originalTgzSha256": ORIGINAL_SHA256, "shimSha256": SHIM_SHA256,
        "path": str(output.resolve()), "bytes": len(packed), "sha256": sha256(packed),
        "sha1": hashlib.sha1(packed).hexdigest(),
        "integrity": "sha512-" + base64.b64encode(hashlib.sha512(packed).digest()).decode(),
        "members": [
            {"path": name, "sha256": sha256(data), "bytes": len(data), "mode": oct(mode)}
            for name, (data, mode) in sorted(members.items())
        ],
    }

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--original-tgz", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(package_hotfix(args.original_tgz, args.output), indent=2))

if __name__ == "__main__":
    main()
