import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { z } from "zod";
import type { CallToolResult, JsonObject, ToolDescriptor } from "@mcp-relay/shared";
import { atomicWrite, fileMode, readTextLimited, sha256Buffer } from "../fsutil.js";
import { displayPath, resolveInsideRoot } from "../paths.js";
import { grepFiles, listFiles } from "../search.js";
import { runShell } from "../shell.js";
import { textResult, type PackContext, type ToolPack } from "../pack.js";

const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

function jsonSchema(schema: z.ZodType): JsonObject {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  return generated as JsonObject;
}

function descriptor(
  name: string,
  description: string,
  schema: z.ZodType,
  readOnly: boolean
): ToolDescriptor {
  return {
    name,
    description,
    inputSchema: jsonSchema(schema),
    ...(readOnly ? { annotations: { readOnlyHint: true } } : {})
  };
}

const readSchema = z.object({
  path: z.string().describe("File path, absolute or relative to the device root"),
  offset: z.number().int().min(1).optional().describe("1-based first line"),
  limit: z.number().int().min(1).max(5000).optional().describe("Maximum lines to return")
});

const writeSchema = z.object({
  path: z.string(),
  content: z.string()
});

const editSchema = z.object({
  path: z.string(),
  old_string: z.string().min(1),
  new_string: z.string(),
  replace_all: z.boolean().optional()
});

const bashSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(120000).optional()
});

const grepSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  glob: z.string().optional(),
  ignore_case: z.boolean().optional(),
  max_results: z.number().int().min(1).max(500).optional()
});

const findSchema = z.object({
  pattern: z.string().min(1),
  path: z.string().optional(),
  max_results: z.number().int().min(1).max(1000).optional()
});

const lsSchema = z.object({
  path: z.string().optional()
});

const tools: ToolDescriptor[] = [
  descriptor("read", "Read a text file, optionally a line range. Use this when you need file contents.", readSchema, true),
  descriptor("write", "Create or overwrite a file with exact content. Creates parent directories.", writeSchema, false),
  descriptor("edit", "Replace an exact substring in a file. Fails if old_string is missing or ambiguous unless replace_all is true.", editSchema, false),
  descriptor("bash", "Run a bash command in the device root. Returns exit code, stdout and stderr.", bashSchema, false),
  descriptor("grep", "Search file contents with a JavaScript RegExp. Returns path:line:text.", grepSchema, true),
  descriptor("find", "Find files by glob pattern. Returns paths relative to the device root.", findSchema, true),
  descriptor("ls", "List a directory with type and size.", lsSchema, true)
];

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

export function createMinimalPack(): ToolPack {
  return {
    id: "minimal",
    tools,
    async call(name: string, args: JsonObject, ctx: PackContext): Promise<CallToolResult> {
      try {
        switch (name) {
          case "read": {
            const input = readSchema.parse(args);
            const file = resolveInsideRoot(ctx.root, input.path);
            const text = readTextLimited(file, MAX_READ_BYTES);
            const rawLines = text.split("\n");
            const lines = text === "" ? [] : text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines;
            const offset = input.offset ?? 1;
            if (offset > lines.length) throw new Error(`offset ${offset} is beyond the end of the file (${lines.length} lines)`);
            const limit = input.limit ?? DEFAULT_READ_LINES;
            const slice = lines.slice(offset - 1, offset - 1 + limit);
            const remaining = lines.length - (offset - 1 + slice.length);
            const footer = remaining > 0 ? `\n[truncated: ${remaining} more lines]` : "";
            return textResult(slice.join("\n") + footer);
          }
          case "write": {
            const input = writeSchema.parse(args);
            const file = resolveInsideRoot(ctx.root, input.path);
            const mode = existsSync(file) ? fileMode(file) : 0o644;
            const buffer = Buffer.from(input.content, "utf8");
            atomicWrite(file, buffer, mode);
            return textResult(`wrote ${buffer.length} bytes to ${displayPath(ctx.root, file)}`);
          }
          case "edit": {
            const input = editSchema.parse(args);
            const file = resolveInsideRoot(ctx.root, input.path);
            const text = readTextLimited(file, MAX_READ_BYTES);
            const count = countOccurrences(text, input.old_string);
            if (count === 0) throw new Error("old_string was not found");
            if (count > 1 && !input.replace_all) {
              throw new Error(`old_string occurs ${count} times; pass replace_all=true or make it unique`);
            }
            const next = input.replace_all
              ? text.split(input.old_string).join(input.new_string)
              : text.slice(0, text.indexOf(input.old_string)) +
                input.new_string +
                text.slice(text.indexOf(input.old_string) + input.old_string.length);
            atomicWrite(file, Buffer.from(next, "utf8"), fileMode(file));
            return textResult(`replaced ${input.replace_all ? count : 1} occurrence(s) in ${displayPath(ctx.root, file)}`);
          }
          case "bash": {
            if (!ctx.allowShell) throw new Error("shell tool is disabled on this device; start with --allow-shell");
            const input = bashSchema.parse(args);
            const result = await runShell(ctx.root, input.command, input.cwd, input.timeout_ms ?? 30000);
            const parts = [`exit_code: ${result.timedOut ? "timeout" : result.exitCode ?? result.signal ?? "unknown"}`];
            if (result.stdoutTruncated) parts.push("stdout_truncated: true");
            parts.push("stdout:", result.stdout);
            if (result.stderrTruncated) parts.push("stderr_truncated: true");
            parts.push("stderr:", result.stderr);
            return textResult(parts.join("\n"), result.timedOut || (result.exitCode ?? 1) !== 0);
          }
          case "grep": {
            const input = grepSchema.parse(args);
            const hits = await grepFiles({
              root: ctx.root,
              ...(input.path !== undefined ? { base: input.path } : {}),
              pattern: input.pattern,
              ...(input.glob !== undefined ? { glob: input.glob } : {}),
              ...(input.ignore_case !== undefined ? { ignoreCase: input.ignore_case } : {}),
              maxResults: input.max_results ?? 100
            });
            if (hits.length === 0) return textResult("No matches.");
            return textResult(hits.map((hit) => `${hit.path}:${hit.line}:${hit.text}`).join("\n"));
          }
          case "find": {
            const input = findSchema.parse(args);
            const files = await listFiles(ctx.root, input.path, input.pattern, input.max_results ?? 200);
            if (files.length === 0) return textResult("No files.");
            return textResult(files.map((file) => displayPath(ctx.root, file)).join("\n"));
          }
          case "ls": {
            const input = lsSchema.parse(args);
            const dir = input.path ? resolveInsideRoot(ctx.root, input.path) : ctx.root;
            const info = statSync(dir);
            if (!info.isDirectory()) throw new Error(`not a directory: ${displayPath(ctx.root, dir)}`);
            const entries = readdirSync(dir, { withFileTypes: true }).slice(0, 1000);
            const rows = entries.map((entry) => {
              const absolute = `${dir}/${entry.name}`;
              let kind = "?";
              let size = 0;
              try {
                const stat = lstatSync(absolute);
                kind = stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "link" : stat.isFile() ? "f" : "?";
                size = stat.size;
              } catch {
                // keep unknown
              }
              return `${kind} ${size} ${entry.name}`;
            });
            rows.sort();
            return textResult(rows.join("\n"));
          }
          default:
            return textResult(`unknown minimal tool: ${name}`, true);
        }
      } catch (error) {
        return textResult((error as Error).message, true);
      }
    }
  };
}
