export type ComputerAction =
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; clicks?: number }
  | { type: "drag"; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
  | { type: "scroll"; direction: "up" | "down" | "left" | "right"; amount?: number; x?: number; y?: number }
  | { type: "key"; keys: string[] }
  | { type: "text"; text: string };

export type ComputerActionType = ComputerAction["type"];

export interface ComputerDisplay {
  id: string;
  /** Origin in native input coordinates. */
  x: number;
  y: number;
  /** Actual screenshot pixel dimensions, never CSS/logical dimensions. */
  width: number;
  height: number;
  /** Screenshot pixels per native input unit. Defaults to one. */
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  primary?: boolean;
  name?: string;
}

export interface ComputerApp {
  id?: string;
  title?: string;
}

export interface ComputerState {
  platform: NodeJS.Platform;
  backend: string;
  available: boolean;
  displayKind: "physical" | "virtual" | "none" | "unknown";
  inputKind: "mouse_keyboard" | "touch" | "none";
  displays: ComputerDisplay[];
  actions: ComputerActionType[];
  unicodeText: boolean;
  permissions: Record<string, "granted" | "denied" | "unknown" | "not-needed">;
  app?: ComputerApp;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface NativeContext {
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface CapturedScreen {
  data: Buffer;
  mimeType: "image/png";
  display: ComputerDisplay;
  capturedAt: number;
  app?: ComputerApp;
}

export interface ComputerBackend {
  readonly id: string;
  /** Explicit setup only; inspecting capabilities must never install or grant permissions. */
  setup?(context: NativeContext): Promise<Record<string, unknown>>;
  inspect(context: NativeContext): Promise<ComputerState>;
  screenshot(displayId: string | undefined, context: NativeContext): Promise<CapturedScreen>;
  /** All action coordinates are local pixels of the supplied screenshot/display. */
  act(action: ComputerAction, display: ComputerDisplay, context: NativeContext): Promise<Record<string, unknown>>;
}

export interface NativeCommand {
  command: string;
  args: string[];
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}

export interface NativeResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

export class ComputerError extends Error {
  constructor(public readonly code: string, message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ComputerError";
  }
}

export function nativePoint(display: ComputerDisplay, x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(display.x + x / (display.scaleX ?? 1)),
    y: Math.round(display.y + y / (display.scaleY ?? 1))
  };
}
