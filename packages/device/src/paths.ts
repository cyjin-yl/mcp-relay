import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function createRoot(input: string): string {
  const root = realpathSync(resolve(input));
  const st = statSync(root);
  if (!st.isDirectory()) throw new Error(`root is not a directory: ${input}`);
  return root;
}

function inside(root: string, candidate: string): boolean {
  // Native relative paths handle Windows drive-letter case and UNC roots.
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

export function resolveInsideRoot(root: string, input: string): string {
  if (!input || input.includes("\0")) throw new Error("invalid path");
  const candidate = isAbsolute(input) ? resolve(input) : resolve(root, input);
  let probe = candidate;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  const realProbe = realpathSync(probe);
  const resolved = tail.length > 0 ? resolve(realProbe, ...tail) : realProbe;
  if (!inside(root, resolved)) {
    throw new Error(`path escapes root: ${input}`);
  }
  if (existsSync(resolved)) {
    const final = realpathSync(resolved);
    if (!inside(root, final)) throw new Error(`path escapes root via symlink: ${input}`);
    return final;
  }
  return resolved;
}

export function displayPath(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === "" ? "." : rel.split(sep).join("/");
}

export function ensureRegularFile(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile()) throw new Error(`not a regular file: ${path}`);
}
