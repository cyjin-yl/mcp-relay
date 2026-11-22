import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { resolveInsideRoot } from "./paths.js";

export type PatchResult = {
  path: string;
  action: "add" | "update" | "delete" | "move";
  oldSha256?: string;
  newSha256?: string;
  bytes?: number;
};

type Hunk = { oldLines: string[]; newLines: string[] };

type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo?: string; hunks: Hunk[] };

type Section = { header: string; body: string[] };

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let index = 0;
  while (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  if ((lines[index] ?? "").trim() !== "*** Begin Patch") {
    throw new Error("patch must start with *** Begin Patch");
  }
  index += 1;
  const sections: Section[] = [];
  let current: Section | null = null;
  let sawEnd = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "*** End Patch") {
      sawEnd = true;
      break;
    }
    if (line.startsWith("*** Move to:") && current?.header.startsWith("*** Update File:")) {
      current.body.push(line);
      continue;
    }
    if (line.startsWith("*** ")) {
      if (current) sections.push(current);
      current = { header: line, body: [] };
      continue;
    }
    if (!current) {
      if (line.trim() === "") continue;
      throw new Error(`text outside a patch section: ${JSON.stringify(line)}`);
    }
    current.body.push(line);
  }
  if (!sawEnd) throw new Error("patch is missing *** End Patch");
  if (current) sections.push(current);
  if (sections.length === 0) throw new Error("patch has no file sections");

  return sections.map((section) => {
    const add = /^\*\*\* Add File:\s*(.+)$/.exec(section.header);
    if (add) {
      const path = (add[1] ?? "").trim();
      if (!path) throw new Error("Add File requires a path");
      const lines = section.body.map((line) => {
        if (line === "") return "";
        if (!line.startsWith("+")) throw new Error(`Add File lines must start with +: ${JSON.stringify(line)}`);
        return line.slice(1);
      });
      return { kind: "add", path, lines } satisfies PatchOp;
    }
    const del = /^\*\*\* Delete File:\s*(.+)$/.exec(section.header);
    if (del) {
      const path = (del[1] ?? "").trim();
      if (!path) throw new Error("Delete File requires a path");
      if (section.body.some((line) => line.trim() !== "")) throw new Error("Delete File must not have a body");
      return { kind: "delete", path } satisfies PatchOp;
    }
    const upd = /^\*\*\* Update File:\s*(.+)$/.exec(section.header);
    if (!upd) throw new Error(`unknown patch section: ${section.header}`);
    const path = (upd[1] ?? "").trim();
    if (!path) throw new Error("Update File requires a path");
    let moveTo: string | undefined;
    const hunks: Hunk[] = [];
    let hunk: Hunk | null = null;
    for (const line of section.body) {
      const move = /^\*\*\* Move to:\s*(.+)$/.exec(line);
      if (move) {
        if (moveTo) throw new Error("duplicate Move to header");
        moveTo = (move[1] ?? "").trim();
        continue;
      }
      if (line.startsWith("@@")) {
        if (hunk) hunks.push(hunk);
        hunk = { oldLines: [], newLines: [] };
        continue;
      }
      if (!hunk) {
        if (line.trim() === "") continue;
        throw new Error(`Update File content before @@ hunk: ${JSON.stringify(line)}`);
      }
      if (line === "\\ No newline at end of file") continue;
      const prefix = line[0];
      const content = line.slice(1);
      if (prefix === " ") {
        hunk.oldLines.push(content);
        hunk.newLines.push(content);
      } else if (prefix === "-") {
        hunk.oldLines.push(content);
      } else if (prefix === "+") {
        hunk.newLines.push(content);
      } else if (line === "") {
        throw new Error("empty hunk line must start with ' ', '+' or '-'");
      } else {
        throw new Error(`invalid hunk line: ${JSON.stringify(line)}`);
      }
    }
    if (hunk) hunks.push(hunk);
    if (hunks.length === 0 && !moveTo) throw new Error(`Update File ${path} has no hunks and no move target`);
    return { kind: "update", path, ...(moveTo ? { moveTo } : {}), hunks } satisfies PatchOp;
  });
}

function findOccurrences(haystack: string[], needle: string[], start: number): number[] {
  if (needle.length === 0) return [];
  const found: number[] = [];
  for (let i = start; i + needle.length <= haystack.length; i += 1) {
    let matches = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        matches = false;
        break;
      }
    }
    if (matches) found.push(i);
  }
  return found;
}

function applyHunks(original: string, hunks: Hunk[], path: string): string {
  const lines = original.split("\n");
  let cursor = 0;
  for (const [index, hunk] of hunks.entries()) {
    if (hunk.oldLines.length === 0) {
      throw new Error(`${path}: hunk ${index + 1} has no context lines`);
    }
    const occurrences = findOccurrences(lines, hunk.oldLines, 0);
    if (occurrences.length === 0) {
      throw new Error(`${path}: hunk ${index + 1} context not found`);
    }
    if (occurrences.length > 1) {
      throw new Error(`${path}: hunk ${index + 1} context is ambiguous (${occurrences.length} matches)`);
    }
    const at = occurrences[0];
    if (at === undefined || at < cursor) {
      throw new Error(`${path}: hunk ${index + 1} overlaps an earlier hunk`);
    }
    lines.splice(at, hunk.oldLines.length, ...hunk.newLines);
    cursor = at + hunk.newLines.length;
  }
  return lines.join("\n");
}

type Planned = {
  op: PatchOp;
  source?: string;
  dest?: string;
  original?: Buffer;
  mode?: number;
  next?: Buffer;
};

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function writeAtomic(path: string, data: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const temp = `${path}.mcp-relay-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    writeFileSync(temp, data, { mode });
    chmodSync(temp, mode);
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

export function applyPatch(
  root: string,
  patchText: string,
  expectedHashes?: Record<string, string>
): PatchResult[] {
  const ops = parsePatch(patchText);
  const hashMap = new Map<string, string>();
  if (expectedHashes) {
    for (const [rawPath, digest] of Object.entries(expectedHashes)) {
      const absolute = resolveInsideRoot(root, rawPath);
      if (!/^[0-9a-f]{64}$/i.test(digest)) throw new Error(`expected hash for ${rawPath} is not sha256 hex`);
      hashMap.set(absolute, digest.toLowerCase());
    }
  }
  const plans: Planned[] = [];
  const touched = new Set<string>();
  const seen = new Set<string>();
  const claim = (absolute: string, label: string) => {
    if (seen.has(absolute)) throw new Error(`duplicate patch path: ${label}`);
    seen.add(absolute);
  };

  for (const op of ops) {
    if (op.kind === "add") {
      const dest = resolveInsideRoot(root, op.path);
      if (existsSync(dest)) throw new Error(`Add File target already exists: ${op.path}`);
      claim(dest, op.path);
      const content = op.lines.length > 0 ? op.lines.join("\n") + "\n" : "";
      plans.push({ op, dest, next: Buffer.from(content, "utf8") });
      continue;
    }
    const source = resolveInsideRoot(root, op.path);
    claim(source, op.path);
    touched.add(source);
    if (!existsSync(source)) throw new Error(`file does not exist: ${op.path}`);
    const info = lstatSync(source);
    if (!info.isFile()) throw new Error(`not a regular file: ${op.path}`);
    const original = readFileSync(source);
    const mode = modeOf(source);
    if (op.kind === "delete") {
      plans.push({ op, source, original, mode });
      continue;
    }
    let nextText = "";
    if (op.hunks.length > 0) {
      nextText = applyHunks(original.toString("utf8"), op.hunks, op.path);
    } else {
      nextText = original.toString("utf8");
    }
    const next = Buffer.from(nextText, "utf8");
    const dest = op.moveTo ? resolveInsideRoot(root, op.moveTo) : source;
    if (op.moveTo) {
      if (existsSync(dest)) throw new Error(`Move target already exists: ${op.moveTo}`);
      claim(dest, op.moveTo);
      touched.add(dest);
    }
    plans.push({ op, source, dest, original, mode, next });
  }

  if (expectedHashes) {
    for (const absolute of touched) {
      const expected = hashMap.get(absolute);
      if (!expected) throw new Error(`expected_hashes is missing a touched path: ${absolute}`);
    }
    for (const [absolute, expected] of hashMap) {
      if (!touched.has(absolute)) throw new Error(`expected_hashes contains an untouched path: ${absolute}`);
      const plan = plans.find((item) => item.source === absolute);
      if (!plan?.original) throw new Error(`expected_hashes contains a path that is not a source: ${absolute}`);
      const actual = sha256(plan.original);
      if (actual !== expected) throw new Error(`hash mismatch for ${absolute}: expected ${expected}, got ${actual}`);
    }
  }

  const written: Array<{ path: string; original: Buffer | null; mode?: number }> = [];
  try {
    for (const plan of plans) {
      if (plan.op.kind === "delete") {
        written.push({ path: plan.source as string, original: plan.original ?? null, ...(plan.mode !== undefined ? { mode: plan.mode } : {}) });
        rmSync(plan.source as string);
        continue;
      }
      const dest = plan.dest as string;
      const existed = existsSync(dest);
      if (!existed) {
        written.push({ path: dest, original: null });
      } else if (existed) {
        const original = plan.op.kind === "update" ? plan.original ?? readFileSync(dest) : readFileSync(dest);
        written.push({ path: dest, original, mode: plan.mode ?? modeOf(dest) });
      }
      writeAtomic(dest, plan.next ?? Buffer.alloc(0), plan.mode ?? 0o644);
      if (plan.op.kind === "update" && plan.op.moveTo && plan.source) {
        written.push({ path: plan.source, original: plan.original ?? null, ...(plan.mode !== undefined ? { mode: plan.mode } : {}) });
        rmSync(plan.source);
      }
    }
  } catch (error) {
    for (const item of written.reverse()) {
      try {
        if (item.original === null) {
          rmSync(item.path, { force: true });
        } else {
          writeFileSync(item.path, item.original, { mode: item.mode ?? 0o644 });
        }
      } catch {
        // best effort rollback
      }
    }
    throw error;
  }

  return plans.map((plan) => {
    const op = plan.op;
    if (op.kind === "add") {
      const bytes = plan.next?.length ?? 0;
      return { path: op.path, action: "add" as const, newSha256: sha256(plan.next ?? Buffer.alloc(0)), bytes };
    }
    if (op.kind === "delete") {
      return { path: op.path, action: "delete" as const, oldSha256: sha256(plan.original ?? Buffer.alloc(0)) };
    }
    if (op.moveTo) {
      return {
        path: op.moveTo,
        action: "move" as const,
        oldSha256: sha256(plan.original ?? Buffer.alloc(0)),
        newSha256: sha256(plan.next ?? Buffer.alloc(0)),
        bytes: plan.next?.length ?? 0
      };
    }
    return {
      path: op.path,
      action: "update" as const,
      oldSha256: sha256(plan.original ?? Buffer.alloc(0)),
      newSha256: sha256(plan.next ?? Buffer.alloc(0)),
      bytes: plan.next?.length ?? 0
    };
  });
}
