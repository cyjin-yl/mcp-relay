#!/usr/bin/env node
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { defaultConfigPath, loadDeviceConfig, saveDeviceConfig } from "./config.js";
import { describeDevice, runConnection, type ConnectionControl, type SupervisorMessage } from "./connection.js";
import { pairDevice } from "./pairing.js";
import { createRoot } from "./paths.js";
import { createMinimalPack } from "./packs/minimal.js";
import { createOmpPack } from "./packs/omp.js";
import { createKernelPack } from "./packs/kernel.js";
import { createComputerPack, selectComputerBackend } from "./packs/computer.js";
import { computerSettingsPath, readComputerSettings, writeComputerSettings } from "./computer/settings.js";
import { runLauncher, runSupervisor, readUpdateStatus, requestUpdateCheck, requestWorkerReload, acquireUpdateLock } from "./updater.js";
import type { ToolPack } from "./pack.js";

const VERSION = "0.1.12";
const DEFAULT_URL = "https://relay.cyjin.dev";
const SUPPORTED_PACKS: Record<string, true> = { minimal: true, omp: true, kernel: true, computer: true };

const HELP = `mcp-relay ${VERSION}

Usage:
  npx -y @cyjin/mcp-relay connect --code ABCD-EFGH [options]
  npx -y @cyjin/mcp-relay connect [options]
  npx -y @cyjin/mcp-relay update-status [--config <path>]
  npx -y @cyjin/mcp-relay update-check [--config <path>]
  npx -y @cyjin/mcp-relay computer-enable|computer-disable [--config <path>]
  npx -y @cyjin/mcp-relay computer-status|computer-setup [--config <path>]
  npx -y @cyjin/mcp-relay computer-pause|computer-resume [--config <path>]

Options:
  --code <code>       One-time pairing code from the relay dashboard
  --root <dir>        Confine all file tools to this directory (default: cwd)
  --packs <list>      Comma-separated packs: minimal,omp,kernel,computer (default: minimal,omp)
  --name <name>       Device name (default: hostname)
  --url <url>         Relay base URL (default: ${DEFAULT_URL})
  --config <path>     Device config (default: ~/.mcp-relay/device.json)
  --allow-shell      Enable platform shell tools (default: on)
  --no-shell         Disable shell tools
  --allow-kernel     Enable persistent code kernel (opt-in; VM is not a security boundary)
  --allow-computer   Enable native screen/input tools (explicit opt-in; not confined to --root)
  --no-auto-update   Disable the online update supervisor
  --update-manifest <url>  Explicit trusted HTTPS release manifest
  --update-interval <sec>  Update check interval, 10..86400 (default: 300)
  --verbose          Log tool calls
  --help             Show this help
  --version          Show the version

Windows exposes powershell explicitly; bash requires an installed Git Bash.
Automatic updates drain active work and reconnect briefly, with rollback on failure.
computer-enable persists opt-in and requests a safely drained worker reload; computer-disable/pause stop active control.
OS screen/input permission prompts must be approved locally; locked desktops remain unavailable.
`;

function log(message: string): void {
  process.stderr.write(`[mcp-relay] ${new Date().toISOString()} ${message}\n`);
}

function updateDirectory(configPath: string): string {
  let canonical = resolve(configPath);
  try { canonical = realpathSync(canonical); } catch { /* first start has no config yet */ }
  const identity = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return join(dirname(canonical), "updates", suffix);
}

async function promptCode(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("no pairing code and no saved device token; pass --code");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question("Pairing code (from the relay dashboard): ")).trim(); }
  finally { rl.close(); }
}

async function main(): Promise<number> {
  // The independent desktop broker does not load a device token or connect.
  if (process.argv[2] === "workspace-broker") {
    const brokerArgs = parseArgs({
      args: process.argv.slice(3),
      options: { "workspace-directory": { type: "string" } }
    });
    const directory = brokerArgs.values["workspace-directory"];
    if (!directory || resolve(directory) !== directory) throw new Error("workspace-directory must be absolute");
    const { runWorkspaceBroker } = await import("./computer/workspace-broker.js");
    const { createWorkspaceProvider } = await import("./computer/workspace-provider.js");
    return runWorkspaceBroker(directory, await createWorkspaceProvider());
  }
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      code: { type: "string" }, root: { type: "string" }, packs: { type: "string" },
      name: { type: "string" }, url: { type: "string" }, config: { type: "string" },
      "allow-shell": { type: "boolean" }, "no-shell": { type: "boolean" },
      "allow-kernel": { type: "boolean" }, "allow-computer": { type: "boolean" }, "no-auto-update": { type: "boolean" },
      "update-manifest": { type: "string" }, "update-interval": { type: "string" },
      verbose: { type: "boolean" }, help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" }
    }
  });
  const values = parsed.values;
  if (values.help) { process.stdout.write(HELP); return 0; }
  if (values.version) { process.stdout.write(`${VERSION}\n`); return 0; }
  const command = parsed.positionals[0] ?? "connect";
  const configPath = resolve(values.config ?? defaultConfigPath());
  if (command.startsWith("computer-")) {
    const allowed = ["computer-enable", "computer-disable", "computer-pause", "computer-resume", "computer-status", "computer-setup"];
    if (!allowed.includes(command)) throw new Error("unknown computer command " + command);
    if (command === "computer-enable" || command === "computer-disable") {
      const settings = writeComputerSettings(configPath, { enabled: command === "computer-enable" });
      const reloadRequested = command === "computer-enable";
      if (reloadRequested) {
        await requestWorkerReload(updateDirectory(configPath), settings.revision);
        await requestUpdateCheck(updateDirectory(configPath));
      }
      process.stdout.write(JSON.stringify({ ...settings, settingsPath: computerSettingsPath(configPath),
        workerReloadRequested: reloadRequested,
        activation: reloadRequested ? "managed supervisor reload after safe drain, or next managed start" : "disabled immediately" }) + "\n");
      return 0;
    }
    if (command === "computer-pause" || command === "computer-resume") {
      process.stdout.write(JSON.stringify(writeComputerSettings(configPath, { paused: command === "computer-pause" })) + "\n");
      return 0;
    }
    const settings = readComputerSettings(configPath, values["allow-computer"]);
    if (command === "computer-status") {
      process.stdout.write(JSON.stringify({ ...settings, settingsPath: computerSettingsPath(configPath) }, null, 2) + "\n");
      return 0;
    }
    if (!settings.enabled || settings.paused) throw new Error("Enable and resume computer control before setup.");
    const backend = selectComputerBackend();
    if (backend.setupInWorker) throw new Error("Wayland permissions belong to the running relay worker. Call its computer_setup tool with timeout_ms:120000, then approve the system desktop dialog. The one-shot CLI cannot transfer that permission session to another process.");
    const release = await acquireUpdateLock(join((await import("node:os")).homedir(), ".mcp-relay", "computer-control"), "desktop");
    try {
      const context = { signal: AbortSignal.timeout(120000), timeoutMs: 120000 };
      const result = backend.setup ? await backend.setup(context) : { state: await backend.inspect(context) };
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } finally { await backend.close?.(); await release(); }
    return 0;
  }
  if (command === "update-status") {
    process.stdout.write(`${JSON.stringify(readUpdateStatus(updateDirectory(configPath)), null, 2)}\n`);
    return 0;
  }
  if (command === "update-check") {
    await requestUpdateCheck(updateDirectory(configPath));
    process.stdout.write("Update check requested.\n");
    return 0;
  }
  if (command !== "connect") {
    process.stderr.write(`unknown command ${command}\n\n${HELP}`);
    return 2;
  }
  const pollSeconds = Number(values["update-interval"] ?? "300");
  if (!Number.isFinite(pollSeconds) || pollSeconds < 10 || pollSeconds > 86400) {
    throw new Error("--update-interval must be between 10 and 86400 seconds");
  }
  const url = (values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)) {
    throw new Error("--url must be https outside localhost");
  }
  const rootInput = values.root ?? process.cwd();
  const packsInput = (values.packs ?? "minimal,omp").split(",").map((item) => item.trim()).filter(Boolean);
  for (const pack of packsInput) {
    if (!SUPPORTED_PACKS[pack]) throw new Error(`unsupported pack ${pack}; supported: ${Object.keys(SUPPORTED_PACKS).join(",")}`);
  }
  const computerSettings = readComputerSettings(configPath, values["allow-computer"]);
  const allowComputer = computerSettings.enabled;
  if (packsInput.includes("computer") && !allowComputer && !existsSync(computerSettingsPath(configPath))) throw new Error("computer pack requires --allow-computer or computer-enable");
  if (allowComputer && !packsInput.includes("computer")) packsInput.push("computer");
  const deviceName = values.name ?? hostname();
  const allowShell = values["no-shell"] !== true;
  const allowKernel = values["allow-kernel"] === true;
  if (packsInput.includes("kernel") && !allowKernel) throw new Error("kernel pack requires --allow-kernel");

  let config = loadDeviceConfig(configPath);
  let code = values.code?.trim();
  if (config && values.url && config.url !== url) {
    log(`saved device belongs to ${config.url}; a new --code is required for ${url}`);
    config = null;
  }
  if (!config || code) {
    if (!code) code = await promptCode();
    if (!code) throw new Error("pairing code is empty");
    config = await pairDevice({
      url, code, name: deviceName, platform: describeDevice().platform,
      arch: describeDevice().arch, packs: packsInput, version: VERSION
    });
    saveDeviceConfig(configPath, config);
    log(`paired device ${config.slug}; config saved to ${configPath}`);
  }
  const root = createRoot(rootInput);
  const supervisedWorker = process.env.MCP_RELAY_WORKER === "1" && typeof process.send === "function";
  const sourceEntry = /\.(?:[cm]?ts|tsx)$/.test(process.argv[1] ?? "");
  const supervisorProcess = !supervisedWorker && process.env.MCP_RELAY_SUPERVISOR === "1" && typeof process.send === "function";
  if (!supervisedWorker && (supervisorProcess || (values["no-auto-update"] !== true && !sourceEntry))) {
    // Use explicit, restartable arguments; never pass the one-time pairing code
    // or the device token to child process command lines or update state files.
    const args = [
      "connect", "--root", root, "--config", configPath, "--name", deviceName,
      "--packs", packsInput.join(","), "--no-auto-update"
    ];
    // Both supervisor generations and workers retain the caller's release channel.
    args.push("--update-interval", String(pollSeconds));
    if (values["update-manifest"]) args.push("--update-manifest", values["update-manifest"]);
    if (!allowShell) args.push("--no-shell");
    if (allowKernel) args.push("--allow-kernel");
    if (values["allow-computer"]) args.push("--allow-computer");
    if (values.verbose) args.push("--verbose");
    const start = supervisorProcess ? runSupervisor : runLauncher;
    return start({
      entryPoint: resolve(process.argv[1]!), version: VERSION, args,
      relayUrl: config.url, stateDir: updateDirectory(configPath),
      ...(values["update-manifest"] ? { manifestUrl: values["update-manifest"] } : {}),
      pollIntervalMs: pollSeconds * 1000, log
    });
  }

  const packs: ToolPack[] = [];
  if (packsInput.includes("minimal")) packs.push(createMinimalPack());
  if (packsInput.includes("omp")) packs.push(createOmpPack());
  if (packsInput.includes("kernel")) packs.push(createKernelPack());
  if (packsInput.includes("computer")) packs.push(createComputerPack({ configPath, defaultEnabled: values["allow-computer"] }));
  const control: ConnectionControl | undefined = supervisedWorker ? {
    send: (message) => {
      if (!process.connected) return;
      try {
        process.send!(message, (error) => {
          if (error) parentAbort.abort(new Error("update supervisor IPC closed"));
        });
      } catch { parentAbort.abort(new Error("update supervisor IPC closed")); }
    },
    subscribe: (listener) => {
      const onMessage = (message: unknown) => {
        if (message && typeof message === "object" && "type" in message) listener(message as SupervisorMessage);
      };
      process.on("message", onMessage);
      return () => process.off("message", onMessage);
    }
  } : undefined;
  log(`serving ${packs.length} pack(s) from ${root}`);
  log(`device ${config.slug} -> ${config.url}`);
  const parentAbort = new AbortController();
  const onParentDisconnect = () => parentAbort.abort(new Error("update supervisor disconnected"));
  if (supervisedWorker) process.once("disconnect", onParentDisconnect);
  let releaseWorkerLock: (() => Promise<void>) | undefined;
  try {
    while (!releaseWorkerLock) {
      parentAbort.signal.throwIfAborted();
      try { releaseWorkerLock = await acquireUpdateLock(updateDirectory(configPath), "worker"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "UPDATE_LOCK_BUSY") throw error;
        await delay(250, undefined, { signal: parentAbort.signal });
      }
    }
    return await runConnection({
      config, root, name: deviceName, packs, allowShell, allowKernel,
      version: VERSION, log, ...(control ? { control, signal: parentAbort.signal } : {}),
      startPaused: supervisedWorker && process.env.MCP_RELAY_START_DRAINED === "1"
    });
  } finally {
    process.off("disconnect", onParentDisconnect);
    await releaseWorkerLock?.();
  }
}

main().then((code) => {
  process.exitCode = code;
  if (process.env.MCP_RELAY_WORKER === "1" && process.connected) process.disconnect();
}).catch((error: unknown) => {
  process.stderr.write(`[mcp-relay] ${(error as Error).message}\n`);
  process.exitCode = 2;
  if (process.env.MCP_RELAY_WORKER === "1" && process.connected) process.disconnect();
});
