import type { WorkspaceCallIdentity, WorkspaceTransport } from "./computer/workspace-types.js";
import type { CallToolResult, JsonObject, ToolDescriptor } from "@mcp-relay/shared";

export type PackContext = {
  root: string;
  allowShell: boolean;
  allowKernel: boolean;
  /** Aborted on the call deadline, relay cancellation, or disconnection. */
  signal?: AbortSignal;
  /** Separate from one call: authenticated device WebSocket lifetime. */
  connection?: WorkspaceTransport;
  /** Injected by the relay server from its verified caller, never from tool args. */
  caller?: WorkspaceCallIdentity;
  fileState?: Map<string, string>;
  log: (message: string) => void;
};

export interface ToolPack {
  id: string;
  tools: ToolDescriptor[];
  /** State which cannot survive a worker restart must explicitly defer updates. */
  updateBlockedReason?: () => string | undefined;
  connectionClosed?: (epoch: string) => void;
  revokeWorkspaceOwner?: (ownerKey: string) => Promise<void>;
  dispose?: () => Promise<void>;
  call(name: string, args: JsonObject, ctx: PackContext): Promise<CallToolResult>;
}

export function textResult(text: string, isError = false): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

export function jsonResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}
