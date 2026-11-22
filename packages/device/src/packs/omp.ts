import { z } from "zod";
import type { CallToolResult, JsonObject, ToolDescriptor } from "@mcp-relay/shared";
import { fileMode, readTextLimited, sha256Buffer } from "../fsutil.js";
import { applyPatch } from "../patch.js";
import { displayPath, resolveInsideRoot } from "../paths.js";
import { astGrep, grepFiles, listFiles } from "../search.js";
import { jsonResult, textResult, type PackContext, type ToolPack } from "../pack.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;

function jsonSchema(schema: z.ZodType): JsonObject {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  return generated as JsonObject;
}

function descriptor(name: string, description: string, schema: z.ZodType, readOnly: boolean): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: jsonSchema(schema),
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {})
  };
}

const readSchema = z.object({
  path: z.string(),
  selector: z.string().optional().describe("Line selector: :50, :50-80, :-40, :50-, or omitted")
});

const hashSchema = z.object({
  path: z.string()
});

const patchSchema = z.object({
  patch: z.string().min(1),
  expected_hashes: z.record(z.string(), z.string()).optional()
});

const globSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional()
});

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignore_case: z.boolean().optional(),
  max_results: z.number().int().min(1).max(500).optional()
});

const astSchema = z.object({
  pattern: z.string().min(1).describe("ast-grep structural pattern, e.g. console.log($A)"),
  lang: z.string().optional().describe("Language, e.g. ts, js, rust, go, python"),
  path: z.string().optional(),
  max_results: z.number().int().min(1).max(200).optional()
});

const tools: ToolDescriptor[] = [
  descriptor("omp_read", "Read a file with 1-based line numbers and an optional :start-end selector.", readSchema, true),
  descriptor("omp_hash", "Return the SHA-256, byte size and mode of a file. Use before omp_apply_patch.", hashSchema, true),
  descriptor("omp_apply_patch", "Apply a *** Begin Patch patch with optional base SHA-256 preconditions; verifies every hash before writing and rolls back on failure.", patchSchema, false),
  descriptor("omp_glob", "List files matching a glob pattern, relative to the device root.", globSchema, true),
  descriptor("omp_grep", "Search file contents with a RegExp and line numbers (uses ripgrep when available).", grepSchema, true),
  descriptor("omp_ast_grep", "Structural code search with ast-grep (sg). Requires ast-grep on the device.", astSchema, true)
];

function parseSelector(selector: string | undefined): { start: number; end: number | null; single: boolean } {
  if (!selector || selector.trim() === "") return { start: 1, end: null, single: false };
  const match = /^:(\d*)(?:-(\d*))?$/.exec(selector.trim());
  if (!match) throw new Error(`invalid selector ${selector}; use :50, :50-80, :-40 or :50-`);
  const left = match[1] ?? "";
  const right = match[2];
  if (right === undefined) {
    const line = Number(left);
    if (!Number.isInteger(line) || line < 1) throw new Error(`invalid selector ${selector}`);
    return { start: line, end: line, single: true };
  }
  const start = left === "" ? 1 : Number(left);
  const end = right === "" ? null : Number(right);
  if (!Number.isInteger(start) || start < 1 || (end !== null && (!Number.isInteger(end) || end < start))) {
    throw new Error(`invalid selector ${selector}`);
  }
  return { start, end, single: false };
}

export function createOmpPack(): ToolPack {
  return {
    id: "omp",
    tools,
    async call(name: string, args: JsonObject, ctx: PackContext): Promise<CallToolResult> {
      try {
        switch (name) {
          case "omp_read": {
            const input = readSchema.parse(args);
            const file = resolveInsideRoot(ctx.root, input.path);
            const text = readTextLimited(file, MAX_READ_BYTES);
            const rawLines = text.split("\n");
            const lines = text === "" ? [] : text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
            const range = parseSelector(input.selector);
            if (range.start > lines.length) throw new Error(`selector starts beyond the end of the file (${lines.length} lines)`);
            const end = range.end === null ? lines.length : Math.min(range.end, lines.length);
            const selected = lines.slice(range.start - 1, end);
            const rows = selected.map((line, index) => `${range.start + index}: ${line}`);
            const remaining = range.end !== null && range.end < lines.length ? 0 : lines.length - end;
            const footer = remaining > 0 ? `\n[truncated: ${remaining} more lines]` : "";
            return textResult(rows.join("\n") + footer);
          }
          case "omp_hash": {
            const input = hashSchema.parse(args);
            const file = resolveInsideRoot(ctx.root, input.path);
            const text = readTextLimited(file, MAX_READ_BYTES);
            const buffer = Buffer.from(text, "utf8");
            return jsonResult({
              path: displayPath(ctx.root, file),
              sha256: sha256Buffer(buffer),
              bytes: buffer.length,
              mode: fileMode(file).toString(8)
            });
          }
          case "omp_apply_patch": {
            const input = patchSchema.parse(args);
            const files = applyPatch(ctx.root, input.patch, input.expected_hashes);
            return jsonResult({ files });
          }
          case "omp_glob": {
            const input = globSchema.parse(args);
            const files = await listFiles(ctx.root, input.path, input.pattern, 1000);
            if (files.length === 0) return textResult("No files.");
            return textResult(files.map((file) => displayPath(ctx.root, file)).join("\n"));
          }
          case "omp_grep": {
            const input = grepSchema.parse(args);
            const hits = await grepFiles({
              root: ctx.root,
              ...(input.path !== undefined ? { base: input.path } : {}),
              pattern: input.pattern,
              ...(input.glob !== undefined ? { glob: input.glob } : {}),
              ...(input.ignore_case !== undefined ? { ignoreCase: input.ignore_case } : {}),
              maxResults: input.max_results ?? 100
            });
            if (hits.length === 0) return textResult("matches: 0");
            return textResult(`matches: ${hits.length}\n` + hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n"));
          }
          case "omp_ast_grep": {
            const input = astSchema.parse(args);
            const hits = await astGrep({
              root: ctx.root,
              ...(input.path !== undefined ? { base: input.path } : {}),
              pattern: input.pattern,
              ...(input.lang !== undefined ? { lang: input.lang } : {}),
              maxResults: input.max_results ?? 100
            });
            if (hits.length === 0) return textResult("matches: 0");
            return textResult(
              `matches: ${hits.length}\n` +
                hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n")
            );
          }
          default:
            return textResult(`unknown omp tool: ${name}`, true);
        }
      } catch (error) {
        return textResult((error as Error).message, true);
      }
    }
  };
}
