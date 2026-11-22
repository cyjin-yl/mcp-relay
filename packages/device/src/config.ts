import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type DeviceConfig = {
  url: string;
  deviceId: string;
  slug: string;
  token: string;
  name: string;
};

export function defaultConfigPath(): string {
  return process.env.MCP_RELAY_CONFIG ?? join(homedir(), ".mcp-relay", "device.json");
}

export function loadDeviceConfig(path: string): DeviceConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeviceConfig>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.slug !== "string" ||
      typeof parsed.token !== "string"
    ) {
      return null;
    }
    return {
      url: parsed.url,
      deviceId: parsed.deviceId,
      slug: parsed.slug,
      token: parsed.token,
      name: typeof parsed.name === "string" ? parsed.name : parsed.slug
    };
  } catch {
    return null;
  }
}

export function saveDeviceConfig(path: string, config: DeviceConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
