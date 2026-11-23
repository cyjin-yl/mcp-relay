import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256Buffer(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function readFileSnapshot(path: string, maxBytes: number): {
  buffer: Buffer;
  text: string;
  sha256: string;
} {
  const info = lstatSync(path);
  if (!info.isFile()) {
    throw new Error(`not a regular file: ${path}`);
  }
  if (info.size > maxBytes) {
    throw new Error(`file is too large (${info.size} bytes, limit ${maxBytes})`);
  }
  const buffer = readFileSync(path);
  // Another process can grow or replace the file after lstat. Hash exactly
  // the bytes returned to the reader, never a second read of the same path.
  if (buffer.length > maxBytes) {
    throw new Error(`file is too large (${buffer.length} bytes, limit ${maxBytes})`);
  }
  return { buffer, text: buffer.toString("utf8"), sha256: sha256Buffer(buffer) };
}

export function readTextLimited(path: string, maxBytes: number): string {
  return readFileSnapshot(path, maxBytes).text;
}

export function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

export function atomicWrite(path: string, data: Buffer, mode?: number): void {
  const effectiveMode = mode ?? 0o644;
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = `${path}.mcp-relay-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temp, data, { mode: effectiveMode });
    chmodSync(temp, effectiveMode);
    renameSync(temp, path);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}
