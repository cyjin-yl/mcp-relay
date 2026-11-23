#!/usr/bin/env python3
"""Build the first-party IME in the development container; never run on the PVE host."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import stat
import subprocess
import uuid
import zipfile


def run(args, *, env=None):
    result = subprocess.run([str(value) for value in args], env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(Path(str(args[0])).name + " failed:\n" + result.stdout + result.stderr)
    return result.stdout + result.stderr


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def private_file(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("signing input must be a regular private file")
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise RuntimeError("signing input is accessible to another user")
    if Path("/workspace") in path.resolve().parents:
        raise RuntimeError("signing secrets must not be inside the shared workspace")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk", default="/opt/android-sdk")
    parser.add_argument("--build-tools", default="35.0.0")
    parser.add_argument("--keystore", default="/root/.local/share/relay-cua-signing/android-input.p12")
    parser.add_argument("--password-file", default="/root/.local/share/relay-cua-signing/android-input.password")
    parser.add_argument("--create-signing-key", action="store_true")
    args = parser.parse_args()
    if not Path("/.dockerenv").exists():
        raise RuntimeError("Android builds are allowed only in the dedicated development container")
    package = Path(__file__).resolve().parent
    workspace = package.parent.parent
    sdk = Path(args.sdk)
    build_tools = sdk / "build-tools" / args.build_tools
    android_jar = sdk / "platforms/android-35/android.jar"
    for item in (android_jar, *(build_tools / name for name in ("aapt2", "d8", "zipalign", "apksigner"))):
        if not item.is_file():
            raise RuntimeError("missing build dependency: " + str(item))
    keystore, password_file = Path(args.keystore), Path(args.password_file)
    if keystore.exists() != password_file.exists():
        raise RuntimeError("partial signing identity exists; preserve it and resolve explicitly")
    if not keystore.exists():
        if not args.create_signing_key:
            raise RuntimeError("no signing identity exists; explicitly pass --create-signing-key for the initial build")
        for path in (keystore, password_file):
            if Path("/workspace") in path.resolve().parents:
                raise RuntimeError("signing identity cannot be created in the shared workspace")
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(path.parent, 0o700)
        password = secrets.token_urlsafe(36)
        descriptor = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(password + "\n")
        environment = dict(os.environ, RELAY_INPUT_KEYSTORE_PASSWORD=password)
        run(["keytool", "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12",
             "-storepass:env", "RELAY_INPUT_KEYSTORE_PASSWORD", "-alias", "relay-input",
             "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000",
             "-dname", "CN=MCP Relay Input, OU=First Party Device Tools, O=cyjin"], env=environment)
        os.chmod(keystore, 0o600)
        # The password never enters command-line arguments, receipts, or shared files.
        del password
    private_file(keystore)
    private_file(password_file)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    out = workspace / ".tmp/android-input-build" / stamp
    out.mkdir(parents=True, exist_ok=False)
    classes, dex = out / "classes", out / "dex"
    classes.mkdir()
    dex.mkdir()
    inputs = [package / "AndroidManifest.xml", Path(__file__).resolve()]
    inputs += sorted((package / "src").rglob("*.java")) + sorted((package / "res").rglob("*.xml"))
    before = {str(path.relative_to(workspace)): digest(path) for path in inputs}
    run([build_tools / "aapt2", "compile", "--dir", package / "res", "-o", out / "resources.zip"])
    run([build_tools / "aapt2", "link", "-I", android_jar, "--manifest", package / "AndroidManifest.xml",
         "--min-sdk-version", "23", "--target-sdk-version", "35", "--version-code", "1",
         "--version-name", "0.1.0", "-o", out / "resources.apk", out / "resources.zip"])
    run(["javac", "--release", "8", "-encoding", "UTF-8", "-classpath", android_jar, "-d", classes,
         *sorted((package / "src").rglob("*.java"))])
    run([build_tools / "d8", "--min-api", "23", "--lib", android_jar, "--output", dex,
         *sorted(classes.rglob("*.class"))])
    with zipfile.ZipFile(out / "resources.apk") as source, zipfile.ZipFile(out / "unsigned.apk", "x") as target:
        for entry in source.infolist():
            target.writestr(entry, source.read(entry.filename))
        target.write(dex / "classes.dex", "classes.dex")
    run([build_tools / "zipalign", "-p", "4", out / "unsigned.apk", out / "aligned.apk"])
    run([build_tools / "apksigner", "sign", "--ks", keystore, "--ks-key-alias", "relay-input",
         "--ks-pass", "file:" + str(password_file), "--out", out / "relay-input.apk", out / "aligned.apk"])
    verification = run([build_tools / "apksigner", "verify", "--verbose", "--print-certs", out / "relay-input.apk"])
    badging = run([build_tools / "aapt2", "dump", "badging", out / "relay-input.apk"])
    if "package: name='dev.cyjin.mcprelay.input'" not in badging or "versionCode='1'" not in badging:
        raise RuntimeError("built package identity differs from the declared input bridge")
    if any("uses-permission:" in line for line in badging.splitlines()):
        raise RuntimeError("the input bridge must not request runtime or network permissions")
    after = {str(path.relative_to(workspace)): digest(path) for path in inputs}
    if before != after:
        raise RuntimeError("source files changed during the APK build")
    apk = (out / "relay-input.apk").read_bytes()
    import base64
    generated = workspace / "packages/device/src/computer/android-bridge.generated.ts"
    artifact = {"version": "0.1.0", "versionCode": 1, "sha256": hashlib.sha256(apk).hexdigest(),
                "base64": base64.b64encode(apk).decode()}
    body = "// Generated by packages/android-input/build.py; signed first-party APK, no signing secrets.\n"
    body += "export const ANDROID_BRIDGE = " + json.dumps(artifact, indent=2) + " as const;\n"
    if generated.exists():
        (out / "previous-android-bridge.generated.ts").write_bytes(generated.read_bytes())
    generated.write_text(body)
    receipt = {"schemaVersion": 1, "package": "dev.cyjin.mcprelay.input", "version": "0.1.0",
               "versionCode": 1, "minSdk": 23, "targetSdk": 35, "bytes": len(apk),
               "sha256": artifact["sha256"], "apk": str((out / "relay-input.apk").relative_to(workspace)),
               "generatedSource": str(generated.relative_to(workspace)), "sourceSha256": before,
               "sourceUnchanged": True, "signatureVerification": verification.strip(),
               "buildTools": args.build_tools, "testedOnDevice": False}
    (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({key: value for key, value in receipt.items() if key not in ("sourceSha256", "signatureVerification")}))
    print("receipt=" + str(out / "receipt.json"))


if __name__ == "__main__":
    main()
