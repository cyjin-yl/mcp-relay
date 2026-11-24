import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nativeEnvironment } from "../src/computer/native.js";
import { linuxWorkspaceHelper } from "../src/computer/workspace-linux-helper.js";
import { createLinuxWorkspaceProvider } from "../src/computer/workspace-linux.js";
import type { WorkspaceOpenOptions, WorkspaceProviderContext } from "../src/computer/workspace-types.js";

const options: WorkspaceOpenOptions = {
  leaseId: "profile-test", width: 800, height: 600,
  expiresAt: 100000, hardExpiresAt: 200000
};

async function checkLaunch(executable: string, args: string[], expectedCode: string) {
  const directory = mkdtempSync(join(tmpdir(), "relay-linux-profile-"));
  try {
    const ctx: WorkspaceProviderContext = {
      journalDirectory: join(directory, "journal"), revocationPath: join(directory, "revoked.json"),
      timeoutMs: 1000, checkpoint: vi.fn(async () => {})
    };
    // Missing dependencies make any accepted launch stop at the read-only
    // probe. A profile override must fail before even that/native allocation.
    const provider = createLinuxWorkspaceProvider({ PATH: "", HOME: join(directory, "physical-home") });
    await expect(provider.open({ ...options, launch: { executable, args } }, ctx))
      .rejects.toMatchObject({ code: expectedCode });
    expect(ctx.checkpoint).not.toHaveBeenCalled();
    expect(existsSync(ctx.journalDirectory)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Linux private application launch", () => {
  it.each([
    ["chromium", ["--user-data-dir", "/physical/profile"]],
    ["google-chrome", ["--user-data-dir=/physical/profile"]],
    ["electron-app", ["--profile-directory=Default"]],
    ["firefox", ["-P", "physical-profile"]],
    ["/usr/bin/firefox-esr", ["--profile=/physical/profile"]],
    ["thunderbird", ["-remote", "openURL(https://example.invalid)"]],
    ["code", ["--reuse-window"]],
    ["/usr/bin/code-insiders", ["-r"]],
    ["libreoffice", ["-env:UserInstallation=file:///physical/profile"]]
  ] as Array<[string, string[]]>)("rejects explicit existing-profile routing in %s before native resources", async (executable, args) => {
    await checkLaunch(executable, args, "workspace_launch_override_unsupported");
  });

  it.each([
    ["ordinary-editor", ["-p", "80"]],
    ["ordinary-editor", ["-r"]],
    ["ordinary-editor", ["--profile=development"]],
    ["ordinary-editor", ["--label=--user-data-dir"]],
    ["firefox", ["--no-remote", "--new-instance"]],
    ["chromium", ["--app=https://example.invalid"]]
  ] as Array<[string, string[]]>)("keeps ordinary non-routing arguments for %s", async (executable, args) => {
    await checkLaunch(executable, args, "isolated_workspace_unavailable");
  });

  it("keeps the existing strict native environment allowlist", () => {
    const result = nativeEnvironment({
      HOME: "/physical/home", PATH: "/usr/bin", DISPLAY: ":0",
      CHROME_USER_DATA_DIR: "/physical/chrome", CHROME_CONFIG_HOME: "/physical/chrome-config",
      CHROME_LOG_FILE: "/physical/log", MOZ_PROFILE: "/physical/firefox",
      MOZ_ENABLE_WAYLAND: "1", VSCODE_IPC_HOOK_CLI: "/physical/code.sock",
      XDG_CONFIG_HOME: "/physical/config", XDG_DATA_HOME: "/physical/data"
    });
    expect(result).toMatchObject({ HOME: "/physical/home", PATH: "/usr/bin", DISPLAY: ":0" });
    for (const key of ["CHROME_USER_DATA_DIR", "CHROME_CONFIG_HOME", "CHROME_LOG_FILE",
      "MOZ_PROFILE", "MOZ_ENABLE_WAYLAND", "VSCODE_IPC_HOOK_CLI", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]) {
      expect(result).not.toHaveProperty(key);
    }
  });
});

// Execute the actual embedded Python functions against real private temporary
// directories. Loading selected definitions avoids starting X11 or a guardian;
// the separate native smoke exercises the full Chromium singleton/handoff path.
const pythonDriver = String.raw`
import ast, json, os, stat, sys, tempfile, types
from pathlib import Path
request = json.loads(sys.stdin.read())
tree = ast.parse(request["source"])
wanted = {"owned_profile_directory", "configure_private", "restore_display", "profile_recovery_details"}
definitions = ast.Module(body=[item for item in tree.body if isinstance(item, ast.FunctionDef) and item.name in wanted], type_ignores=[])
assert len(definitions.body) == len(wanted)
with tempfile.TemporaryDirectory(prefix="relay-profile-functions-") as temp:
    root = Path(temp) / "journal"
    runtime = Path(temp) / "runtime"
    physical_home = Path(temp) / "physical"
    for path in (root, runtime, physical_home): path.mkdir(mode=0o700)
    physical = {"HOME": str(physical_home), "DISPLAY": ":77", "XAUTHORITY": str(physical_home / "Xauthority"),
                "WAYLAND_DISPLAY": "wayland-0", "DBUS_SESSION_BUS_ADDRESS": "unix:path=/physical/bus",
                "XDG_RUNTIME_DIR": str(physical_home / "runtime")}
    scope = {"ROOT": root, "RUNTIME": runtime, "PRIVATE": dict(physical), "PHYSICAL": dict(physical),
             "S": {}, "Path": Path, "os": os, "stat": stat, "types": types, "json": json}
    exec(compile(definitions, "<linux-workspace-helper>", "exec"), scope)
    exec(request["scenario"], scope)
`;

function pythonScenario(scenario: string): Record<string, unknown> {
  const result = spawnSync("python3", ["-c", pythonDriver], {
    input: JSON.stringify({ source: linuxWorkspaceHelper, scenario }),
    encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe.skipIf(process.platform !== "linux")("Linux private profile directory lifecycle", () => {
  it("uses owned 0700 HOME/XDG directories and leaves the physical viewer environment untouched", () => {
    const result = pythonScenario(String.raw`
before = dict(PHYSICAL)
configure_private()
keys = ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME")
paths = [Path(PRIVATE[key]) for key in keys] + [ROOT / "app-home" / ".local"]
print(json.dumps({"physicalUnchanged": PHYSICAL == before,
    "allPrivate": all(p.is_relative_to(ROOT / "app-home") for p in paths),
    "allOwned": all(p.stat().st_uid == os.geteuid() for p in paths),
    "modes": [stat.S_IMODE(p.stat().st_mode) for p in paths],
    "chromeConfigMatches": PRIVATE["CHROME_CONFIG_HOME"] == PRIVATE["XDG_CONFIG_HOME"],
    "physicalHomeUntouched": list(Path(PHYSICAL["HOME"]).iterdir()) == [],
    "privateBusRemoved": "DBUS_SESSION_BUS_ADDRESS" not in PRIVATE,
    "physicalDisplay": PHYSICAL["DISPLAY"]}))
`);
    expect(result).toEqual({
      physicalUnchanged: true, allPrivate: true, allOwned: true, modes: Array(6).fill(0o700),
      chromeConfigMatches: true, physicalHomeUntouched: true, privateBusRemoved: true, physicalDisplay: ":77"
    });
  });

  it.each(["home", "config"])("refuses an existing %s symlink without changing the physical profile", location => {
    const result = pythonScenario(String.raw`
physical = Path(PHYSICAL["HOME"])
physical.chmod(0o751)
(physical / "unsaved.txt").write_text("keep physical data")
if ` + JSON.stringify(location) + String.raw` == "home":
    (ROOT / "app-home").symlink_to(physical, target_is_directory=True)
else:
    (ROOT / "app-home").mkdir(mode=0o700)
    (ROOT / "app-home" / ".config").symlink_to(physical, target_is_directory=True)
refused = False
try: configure_private()
except OSError: refused = True
print(json.dumps({"refused": refused, "physicalMode": stat.S_IMODE(physical.stat().st_mode),
                  "text": (physical / "unsaved.txt").read_text(),
                  "physicalFiles": sorted(p.name for p in physical.iterdir())}))
`);
    expect(result).toEqual({ refused: true, physicalMode: 0o751, text: "keep physical data", physicalFiles: ["unsaved.txt"] });
  });

  it("refuses a journal owned by a different user before creating a profile", () => {
    const result = pythonScenario(String.raw`
real_os = os
os = types.SimpleNamespace(**vars(real_os))
os.geteuid = lambda: real_os.geteuid() + 1
error = None
try: configure_private()
except RuntimeError as failure: error = str(failure)
print(json.dumps({"error": error, "created": (ROOT / "app-home").exists()}))
`);
    expect(result).toEqual({ error: "workspace_profile_directory_not_owned", created: false });
  });

  it("keeps changed profile permissions/content and restores the original private display during handoff", () => {
    const result = pythonScenario(String.raw`
configure_private()
home = Path(PRIVATE["HOME"])
(home / "unsaved.txt").write_text("private document")
config = Path(PRIVATE["XDG_CONFIG_HOME"])
config.chmod(0o500)
S.update({"display": ":93", "appHomeDirectory": str(home), "appProfileIsolated": True})
before = dict(PHYSICAL)
restored = restore_display()
print(json.dumps({"restored": restored, "display": PRIVATE["DISPLAY"],
    "physicalUnchanged": PHYSICAL == before, "text": (home / "unsaved.txt").read_text(),
    "configMode": stat.S_IMODE(config.stat().st_mode), "details": profile_recovery_details()}))
config.chmod(0o700)
`);
    expect(result).toMatchObject({
      restored: true, display: ":93", physicalUnchanged: true, text: "private document", configMode: 0o500,
      details: { profileBindingAtLaunch: "private-home", profileCleanupPerformed: false }
    });
  });

  it("can recover an older receipt even if app-home is now a symlink, without claiming isolation", () => {
    const result = pythonScenario(String.raw`
physical = Path(PHYSICAL["HOME"])
physical.chmod(0o751)
(physical / "unsaved.txt").write_text("older live app")
(ROOT / "app-home").symlink_to(physical, target_is_directory=True)
S.update({"display": ":94"})
restored = restore_display()
print(json.dumps({"restored": restored, "display": PRIVATE["DISPLAY"],
    "text": (physical / "unsaved.txt").read_text(), "physicalMode": stat.S_IMODE(physical.stat().st_mode),
    "details": profile_recovery_details()}))
`);
    expect(result).toEqual({
      restored: true, display: ":94", text: "older live app", physicalMode: 0o751,
      details: { profileBindingAtLaunch: "unverified", profileCleanupPerformed: false }
    });
  });
});

