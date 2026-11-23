import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { atomicWrite } from "../fsutil.js";
import { ComputerError } from "./types.js";

export interface ComputerSettings {
  schema: 1;
  enabled: boolean;
  paused: boolean;
  updatedAt?: string;
  /** Changes only when effective settings change; binds pending managed reloads. */
  revision?: string;
}

export function computerSettingsPath(configPath: string): string {
  let canonical = resolve(configPath);
  try { canonical = realpathSync(canonical); } catch { /* allow provisioning before first connection */ }
  return canonical + ".computer.json";
}

export function readComputerSettings(configPath: string, defaultEnabled = false): ComputerSettings {
  const path = computerSettingsPath(configPath);
  try {
    if (statSync(path).size > 4096) throw new Error("oversized settings");
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!data || typeof data !== "object" || !("schema" in data) || data.schema !== 1
      || !("enabled" in data) || typeof data.enabled !== "boolean"
      || !("paused" in data) || typeof data.paused !== "boolean") throw new Error("invalid settings");
    const revision = "revision" in data ? data.revision : undefined;
    if (revision !== undefined && (typeof revision !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(revision))) {
      throw new Error("invalid revision");
    }
    const updatedAt = "updatedAt" in data && typeof data.updatedAt === "string" && data.updatedAt.length <= 64
      ? data.updatedAt : undefined;
    return { schema: 1, enabled: data.enabled, paused: data.paused,
      ...(revision ? { revision } : {}), ...(updatedAt ? { updatedAt } : {}) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: 1, enabled: defaultEnabled, paused: false };
    }
    throw new ComputerError("invalid_computer_settings", "Computer control settings are invalid; control is disabled.");
  }
}

export function writeComputerSettings(configPath: string, change: Partial<Pick<ComputerSettings, "enabled" | "paused">>,
  defaultEnabled = false): ComputerSettings {
  const current = readComputerSettings(configPath, defaultEnabled);
  const changed = (change.enabled !== undefined && change.enabled !== current.enabled)
    || (change.paused !== undefined && change.paused !== current.paused);
  const next: ComputerSettings = { ...current, ...change, schema: 1, updatedAt: new Date().toISOString(),
    revision: changed || !current.revision ? randomUUID() : current.revision };
  atomicWrite(computerSettingsPath(configPath), Buffer.from(JSON.stringify(next, null, 2) + "\n"), 0o600);
  return next;
}
