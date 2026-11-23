#!/usr/bin/env node
import { hostname } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { defaultConfigPath, loadDeviceConfig, saveDeviceConfig } from "./config.js";
import { describeDevice, runConnection } from "./connection.js";
import { pairDevice } from "./pairing.js";
import { createRoot } from "./paths.js";
import { createMinimalPack } from "./packs/minimal.js";
import { createOmpPack } from "./packs/omp.js";
import { createKernelPack } from "./packs/kernel.js";
import type { ToolPack } from "./pack.js";

const VERSION = "0.1.4";
const VERSION = "0.1.5";
const DEFAULT_URL = "https://relay.cyjin.dev";
const SUPPORTED_PACKS: Record<string, true> = { minimal: true, omp: true, kernel: true };

const HELP = `mcp-relay ${VERSION}

Usage:
  npx -y @cyjin/mcp-relay connect --code ABCD-EFGH [options]
  npx -y @cyjin/mcp-relay --code ABCD-EFGH [options]

Options:
  --code <code>       One-time pairing code from the relay dashboard
  --root <dir>        Confine all file tools to this directory (default: cwd)
  --packs <list>      Comma-separated tool packs: minimal,omp,kernel (default: minimal,omp)
  --name <name>       Device name shown in the dashboard (default: hostname)
  --url <url>         Relay base URL (default: ${DEFAULT_URL})
  --config <path>     Device config path (default: ~/.mcp-relay/device.json)
  --allow-shell       Enable the bash tool (default: on)
  --no-shell          Disable the bash tool
  --allow-kernel      Enable the persistent code kernel (opt-in; VM is not a security boundary)
  --verbose           Log every tool call
  --help              Show this help
  --version           Show the version
`;

function log(message: string): void {
  process.stderr.write(`[mcp-relay] ${new Date().toISOString()} ${message}\n`);
}

async function promptCode(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("no pairing code and no saved device token; pass --code");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question("Pairing code (from the relay dashboard): ")).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      code: { type: "string" },
      root: { type: "string" },
      packs: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      config: { type: "string" },
      "allow-shell": { type: "boolean" },
      "no-shell": { type: "boolean" },
      "allow-kernel": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" }
    }
  });
  const values = parsed.values;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const command = parsed.positionals[0] ?? "connect";
  if (command !== "connect") {
    process.stderr.write(`unknown command ${command}\n\n${HELP}`);
    return 2;
  }

  const url = (values.url ?? DEFAULT_URL).replace(/\/+$/, "");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)) {
    throw new Error("--url must be https outside localhost");
  }
  const configPath = values.config ?? defaultConfigPath();
  const rootInput = values.root ?? process.cwd();
  const packsInput = (values.packs ?? "minimal,omp")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const pack of packsInput) {
    if (!SUPPORTED_PACKS[pack]) {
      throw new Error(`unsupported pack ${pack}; supported: ${Object.keys(SUPPORTED_PACKS).join(",")}`);
    }
  }
  const deviceName = values.name ?? hostname();
  const allowShell = values["no-shell"] !== true;
  const allowKernel = values["allow-kernel"] === true;

  let config = loadDeviceConfig(configPath);
  let code = values.code?.trim();
  if (config && values.url && config.url !== url) {
    log(`saved device belongs to ${config.url}; a new --code is required for ${url}`);
    config = null;
  }
  if (!config || code) {
    if (!code) code = await promptCode();
    if (!code) throw new Error("pairing code is empty");
    const device = await pairDevice({
      url,
      code,
      name: deviceName,
      platform: describeDevice().platform,
      arch: describeDevice().arch,
      packs: packsInput,
      version: VERSION
    });
    saveDeviceConfig(configPath, device);
    config = device;
    log(`paired device ${config.slug}; config saved to ${configPath}`);
  }

  const root = createRoot(rootInput);
  const packs: ToolPack[] = [];
  if (packsInput.includes("minimal")) packs.push(createMinimalPack());
  if (packsInput.includes("omp")) packs.push(createOmpPack());
  if (packsInput.includes("kernel")) {
    if (!allowKernel) throw new Error("kernel pack requires --allow-kernel");
    packs.push(createKernelPack());
  }

  log(`serving ${packs.length} pack(s) from ${root}`);
  log(`device ${config.slug} -> ${config.url}`);
  return runConnection({
    config,
    root,
    name: deviceName,
    packs,
    allowShell,
    allowKernel,
    version: VERSION,
    log
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`[mcp-relay] ${(error as Error).message}\n`);
    process.exitCode = 2;
  });
