import { readdirSync } from "node:fs";
import { inspect } from "node:util";
import vm from "node:vm";
import { z } from "zod";
import type { CallToolResult, JsonObject, ToolDescriptor } from "@mcp-relay/shared";
import { atomicWrite, readTextLimited } from "../fsutil.js";
import { displayPath, resolveInsideRoot } from "../paths.js";
import { textResult, type PackContext, type ToolPack } from "../pack.js";

const MAX_CODE_BYTES = 64 * 1024;
const MAX_OUTPUT_CHARS = 32 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_TIMEOUT_MS = 10000;

const evalSchema = z.object({
  code: z.string().min(1).max(MAX_CODE_BYTES),
  timeout_ms: z.number().int().min(10).max(MAX_TIMEOUT_MS).optional()
});

const resetSchema = z.object({});

function jsonSchema(schema: z.ZodType): JsonObject {
  const generated = z.toJSONSchema(schema) as Record<string, unknown>;
  delete generated.$schema;
  return generated as JsonObject;
}

const tools: ToolDescriptor[] = [
  {
    name: "kernel_eval",
    description:
      "Evaluate JavaScript in a persistent, opt-in code kernel on the device. State survives across calls; console.log output and the returned value are returned. Exposes relay.readFile/writeFile/list under the device root. Not a security boundary.",
    inputSchema: jsonSchema(evalSchema),
    annotations: { destructiveHint: true }
  },
  {
    name: "kernel_reset",
    description: "Reset the persistent code kernel, discarding all JavaScript state.",
    inputSchema: jsonSchema(resetSchema)
  }
];

function format(value: unknown): string {
  return inspect(value, { depth: 4, maxArrayLength: 100, breakLength: 120 });
}

export function createKernelPack(): ToolPack {
  let context: vm.Context;
  const logs: string[] = [];

  function makeSandbox(root: string): Record<string, unknown> {
    return {
      console: {
        log: (...args: unknown[]) => {
          if (logs.length < 200) logs.push(args.map(format).join(" "));
        }
      },
      relay: {
        root,
        readFile: (path: string, maxBytes = MAX_READ_BYTES): string => {
          const file = resolveInsideRoot(root, path);
          return readTextLimited(file, Math.min(maxBytes, MAX_READ_BYTES));
        },
        writeFile: (path: string, contents: string): string => {
          const file = resolveInsideRoot(root, path);
          const buffer = Buffer.from(String(contents), "utf8");
          if (buffer.length > MAX_READ_BYTES) throw new Error("writeFile is limited to 1 MiB");
          atomicWrite(file, buffer);
          return displayPath(root, file);
        },
        list: (path = "."): string[] => {
          const dir = resolveInsideRoot(root, path);
          return readdirSync(dir).slice(0, 1000);
        }
      }
    };
  }

  function reset(root: string): void {
    logs.length = 0;
    context = vm.createContext(makeSandbox(root), { name: "mcp-relay-kernel" });
  }

  return {
    id: "kernel",
    tools,
    async call(name: string, args: JsonObject, ctx: PackContext): Promise<CallToolResult> {
      if (!ctx.allowKernel) return textResult("kernel pack is disabled on this device; start with --allow-kernel", true);
      try {
        if (name === "kernel_reset") {
          resetSchema.parse(args);
          reset(ctx.root);
          return textResult("kernel reset");
        }
        if (name !== "kernel_eval") return textResult(`unknown kernel tool: ${name}`, true);
        const input = evalSchema.parse(args);
        if (Buffer.byteLength(input.code, "utf8") > MAX_CODE_BYTES) throw new Error("code is too large");
        if (!context) reset(ctx.root);
        logs.length = 0;
        const value = vm.runInContext(input.code, context, {
          timeout: input.timeout_ms ?? DEFAULT_TIMEOUT_MS,
          filename: "kernel.js",
          displayErrors: true
        });
        const sections: string[] = [];
        if (logs.length > 0) sections.push(logs.join("\n"));
        if (value !== undefined) sections.push(`=> ${format(value)}`);
        const output = sections.join("\n") || "undefined";
        return textResult(output.length > MAX_OUTPUT_CHARS ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]` : output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return textResult(`kernel error: ${message}`, true);
      }
    }
  };
}
