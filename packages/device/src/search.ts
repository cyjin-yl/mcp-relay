import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";
import { displayPath, resolveInsideRoot } from "./paths.js";

const execFileAsync = promisify(execFile);
const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**"];
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 5000;

export function patternEscapesRoot(pattern: string): boolean {
  const normalized = pattern.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return true;
  return normalized.split("/").some((segment) => segment === "..");
}

export async function listFiles(
  root: string,
  baseInput: string | undefined,
  pattern: string,
  limit: number
): Promise<string[]> {
  const base = baseInput ? resolveInsideRoot(root, baseInput) : root;
  const stat = statSync(base);
  if (stat.isFile()) return [base];
  const globPattern = pattern || "**/*";
  if (patternEscapesRoot(globPattern)) throw new Error(`glob pattern escapes root: ${pattern}`);
  const entries = await fg(globPattern, {
    cwd: base,
    dot: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: DEFAULT_IGNORE,
    absolute: false
  });
  const files: string[] = [];
  for (const rel of entries.slice(0, Math.min(limit, MAX_SCAN_FILES))) {
    try {
      files.push(resolveInsideRoot(root, resolve(base, rel)));
    } catch {
      // a glob result that escapes the root is dropped, not returned
    }
  }
  return files.sort();
}

export type GrepHit = {
  path: string;
  line: number;
  text: string;
};

type RgMatch = {
  type: string;
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
};

function parseRgJson(stdout: string, root: string, maxResults: number): GrepHit[] {
  const hits: GrepHit[] = [];
  for (const line of stdout.split("\n")) {
    if (hits.length >= maxResults) break;
    if (line.trim() === "") continue;
    let message: RgMatch;
    try {
      message = JSON.parse(line) as RgMatch;
    } catch {
      continue;
    }
    if (message.type !== "match") continue;
    const rawPath = message.data.path.text;
    let absolute: string;
    try {
      absolute = resolveInsideRoot(root, rawPath.startsWith("/") ? rawPath : resolve(root, rawPath));
    } catch {
      continue;
    }
    hits.push({
      path: displayPath(root, absolute),
      line: message.data.line_number,
      text: message.data.lines.text.replace(/\n$/, "").slice(0, 2000)
    });
  }
  return hits;
}

async function ripgrep(
  root: string,
  base: string | undefined,
  pattern: string,
  glob: string | undefined,
  ignoreCase: boolean,
  maxResults: number
): Promise<GrepHit[] | null> {
  const target = base ? relative(root, base) || "." : ".";
  const args = [
    "--json",
    "--max-count",
    String(Math.max(1, Math.min(maxResults, 500))),
    ...(ignoreCase ? ["-i"] : []),
    ...(glob ? ["--glob", glob] : []),
    "-e",
    pattern,
    "--",
    target
  ];
  try {
    const { stdout } = await execFileAsync("rg", args, {
      cwd: root,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024
    });
    return parseRgJson(stdout, root, maxResults);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stdout?: string };
    if (failure.code === "ENOENT") return null;
    if (typeof failure.stdout === "string") {
      const hits = parseRgJson(failure.stdout, root, maxResults);
      if (hits.length > 0) return hits;
    }
    return null;
  }
}

export async function grepFiles(options: {
  root: string;
  base?: string;
  pattern: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults: number;
}): Promise<GrepHit[]> {
  const flags = options.ignoreCase ? "i" : "";
  try {
    new RegExp(options.pattern, flags);
  } catch (error) {
    throw new Error(`invalid regular expression: ${(error as Error).message}`);
  }
  const base = options.base ? resolveInsideRoot(options.root, options.base) : undefined;
  if (options.glob && patternEscapesRoot(options.glob)) {
    throw new Error(`glob pattern escapes root: ${options.glob}`);
  }
  const fromRg = await ripgrep(
    options.root,
    base,
    options.pattern,
    options.glob,
    options.ignoreCase === true,
    options.maxResults
  );
  if (fromRg !== null) return fromRg;

  const files = await listFiles(
    options.root,
    options.base,
    options.glob && options.glob.trim() !== "" ? options.glob : "**/*",
    MAX_SCAN_FILES
  );
  const regex = new RegExp(options.pattern, flags);
  const hits: GrepHit[] = [];
  for (const file of files) {
    if (hits.length >= options.maxResults) break;
    let info;
    try {
      info = statSync(file);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
    let buffer: Buffer;
    try {
      buffer = readFileSync(file);
    } catch {
      continue;
    }
    if (buffer.subarray(0, 8000).includes(0)) continue;
    const lines = buffer.toString("utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (regex.test(line)) {
        hits.push({ path: displayPath(options.root, file), line: i + 1, text: line.slice(0, 2000) });
        if (hits.length >= options.maxResults) break;
      }
    }
  }
  return hits;
}

type AstGrepMatch = {
  file: string;
  range: { start: { line: number; column: number } };
  text: string;
};

export async function astGrep(options: {
  root: string;
  base?: string;
  pattern: string;
  lang?: string;
  maxResults: number;
}): Promise<GrepHit[]> {
  const base = options.base ? resolveInsideRoot(options.root, options.base) : options.root;
  const target = relative(options.root, base) || ".";
  const args = [
    "--pattern",
    options.pattern,
    "--json",
    ...(options.lang ? ["--lang", options.lang] : []),
    "--",
    target
  ];
  const stdout = await runAstGrep(args, options.root);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("ast-grep returned non-JSON output");
  }
  if (!Array.isArray(parsed)) throw new Error("ast-grep returned an unexpected result shape");
  const hits: GrepHit[] = [];
  for (const item of parsed as AstGrepMatch[]) {
    if (hits.length >= options.maxResults) break;
    if (!item || typeof item.file !== "string") continue;
    let absolute: string;
    try {
      absolute = resolveInsideRoot(options.root, item.file.startsWith("/") ? item.file : resolve(options.root, item.file));
    } catch {
      continue;
    }
    hits.push({
      path: displayPath(options.root, absolute),
      line: (item.range?.start?.line ?? 0) + 1,
      text: (item.text ?? "").split("\n")[0]?.slice(0, 2000) ?? ""
    });
  }
  return hits;
}

type ExecFailure = NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };

async function runAstGrep(args: string[], cwd: string): Promise<string> {
  const candidates: Array<{ bin: string; verify: boolean }> = [
    { bin: "ast-grep", verify: false },
    { bin: "sg", verify: true }
  ];
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    if (candidate.verify) {
      try {
        const { stdout } = await execFileAsync(candidate.bin, ["--version"], { timeout: 5000 });
        if (!stdout.includes("ast-grep")) continue;
      } catch {
        continue;
      }
    }
    try {
      const { stdout } = await execFileAsync(candidate.bin, args, {
        cwd,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      const failure = error as ExecFailure;
      if (failure.code === "ENOENT") continue;
      if (Number(failure.code) === 1 && (!failure.stdout || failure.stdout.trim() === "")) return "[]";
      if (typeof failure.stdout === "string" && failure.stdout.trim() !== "") return failure.stdout;
      lastError = new Error(failure.stderr?.trim() || `${candidate.bin} failed`);
    }
  }
  throw lastError ?? new Error("ast-grep is not installed on this device (install `ast-grep`)");
}
