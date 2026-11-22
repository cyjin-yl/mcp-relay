import type { DeviceConfig } from "./config.js";

export async function pairDevice(options: {
  url: string;
  code: string;
  name: string;
  platform: string;
  arch: string;
  packs: string[];
  version: string;
}): Promise<DeviceConfig> {
  const endpoint = new URL("/api/device/pair", options.url);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code: options.code,
        name: options.name,
        platform: options.platform,
        arch: options.arch,
        packs: options.packs,
        version: options.version
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    throw new Error(`cannot reach relay: ${(error as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`pairing failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("pairing returned invalid JSON");
  }
  const data = parsed as { deviceId?: unknown; slug?: unknown; token?: unknown; wsUrl?: unknown };
  if (typeof data.deviceId !== "string" || typeof data.slug !== "string" || typeof data.token !== "string") {
    throw new Error("pairing response is missing fields");
  }
  return {
    url: options.url,
    deviceId: data.deviceId,
    slug: data.slug,
    token: data.token,
    name: options.name
  };
}
