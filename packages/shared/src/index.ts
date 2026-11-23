import { createHash } from "node:crypto";

export const PROTOCOL_VERSION = 1 as const;

export const SCOPE_READ = "relay.read";
export const SCOPE_WRITE = "relay.write";
export const SCOPE_OFFLINE = "offline_access";
export const SUPPORTED_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_OFFLINE] as const;
export type Scope = (typeof SUPPORTED_SCOPES)[number];

export const MCP_PATH = "/mcp";
export const DEVICE_WS_PATH = "/device/ws";
export const MAX_TOOLS_PER_DEVICE = 100;
export const MAX_TOOL_CALL_TIMEOUT_MS = 25_000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 20_000;
export const DEVICE_HEARTBEAT_MS = 25_000;
export const DEVICE_SILENCE_LIMIT_MS = 60_000;
export const MAX_INFLIGHT_PER_DEVICE = 8;
export const MAX_DEVICE_HELLO_BYTES = 1024 * 1024;
export const MAX_DEVICE_MESSAGE_BYTES = 20 * 1024 * 1024;
export const MAX_NATIVE_IMAGE_BYTES = 12 * 1024 * 1024;
export const DEFAULT_COMPUTER_CALL_TIMEOUT_MS = 30_000;
export const MAX_COMPUTER_CALL_TIMEOUT_MS = 120_000;

export type JsonObject = { [key: string]: unknown };

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type ToolDescriptor = {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonObject;
  annotations?: ToolAnnotations;
};

export type ContentBlock = JsonObject & { type: string };

/** Native MCP image content; base64 belongs here, never in text/structured metadata. */
export type ImageContentBlock = ContentBlock & {
  type: "image";
  data: string;
  mimeType: string;
};

export type CallToolResult = {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: JsonObject;
};

export type DeviceInfo = {
  name: string;
  platform: string;
  arch: string;
  version: string;
  root?: string;
  packs: string[];
};

export type HelloMessage = {
  type: "hello";
  protocol: typeof PROTOCOL_VERSION;
  device: DeviceInfo;
  tools: ToolDescriptor[];
};

export type HelloAckMessage = {
  type: "hello_ack";
  deviceId: string;
  slug: string;
  serverTime: number;
};

export type CallMessage = {
  type: "call";
  id: string;
  tool: string;
  args: JsonObject;
  timeoutMs: number;
};

export type PingMessage = { type: "ping" };
export type PongMessage = { type: "pong" };

export type DeviceError = { code: string; message: string };

export type ResultMessage =
  | { type: "result"; id: string; ok: true; result: CallToolResult }
  | { type: "result"; id: string; ok: false; error: DeviceError };

export type ServerToDevice = HelloAckMessage | CallMessage | PingMessage;
export type DeviceToServer = HelloMessage | PongMessage | ResultMessage;

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function slugifyDeviceName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  return base || "device";
}

export function deviceToolName(slug: string, tool: string): string {
  const raw = `d_${slug}__${tool}`;
  if (raw.length <= 64) return raw;
  return `${raw.slice(0, 55)}_${hashText(raw).slice(0, 8)}`;
}

export function requiredScope(tool: Pick<ToolDescriptor, "annotations"> & Partial<Pick<ToolDescriptor, "name">>): Scope {
  if (tool.name === "computer_action" || tool.name === "computer_handoff" || tool.name === "computer_setup") return SCOPE_WRITE;
  return tool.annotations?.readOnlyHint === true ? SCOPE_READ : SCOPE_WRITE;
}