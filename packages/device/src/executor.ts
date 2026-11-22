import type { CallToolResult, JsonObject, ToolDescriptor } from "@mcp-relay/shared";
import type { PackContext, ToolPack } from "./pack.js";

export type Executor = {
  tools: ToolDescriptor[];
  call(name: string, args: JsonObject, ctx: PackContext): Promise<CallToolResult>;
};

export function buildExecutor(packs: ToolPack[]): Executor {
  const byName = new Map<string, ToolPack>();
  const tools: ToolDescriptor[] = [];
  for (const pack of packs) {
    for (const tool of pack.tools) {
      if (byName.has(tool.name)) {
        throw new Error(`duplicate tool ${tool.name} from packs ${byName.get(tool.name)?.id} and ${pack.id}`);
      }
      byName.set(tool.name, pack);
      tools.push(tool);
    }
  }
  return {
    tools,
    async call(name: string, args: JsonObject, ctx: PackContext): Promise<CallToolResult> {
      const pack = byName.get(name);
      if (!pack) return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
      return pack.call(name, args, ctx);
    }
  };
}
