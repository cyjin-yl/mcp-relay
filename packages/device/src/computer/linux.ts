import { setTimeout as delay } from "node:timers/promises";
import { ComputerError, nativePoint, type ComputerAction, type ComputerBackend,
  type ComputerDisplay, type ComputerState, type NativeContext } from "./types.js";
import { findExecutable, pngDimensions, runNative } from "./native.js";
import { createWaylandBackend } from "./wayland.js";

const keyNames: Record<string, string> = {
  ctrl: "Control_L", control: "Control_L", alt: "Alt_L", option: "Alt_L",
  shift: "Shift_L", meta: "Super_L", super: "Super_L", win: "Super_L", command: "Super_L",
  enter: "Return", return: "Return", tab: "Tab", escape: "Escape", esc: "Escape",
  backspace: "BackSpace", delete: "Delete", insert: "Insert", space: "space",
  home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  up: "Up", down: "Down", left: "Left", right: "Right", capslock: "Caps_Lock",
  printscreen: "Print"
};
function xKey(key: string): string {
  const known = keyNames[key.toLowerCase()];
  if (known) return known;
  if (/^[a-zA-Z0-9]$/.test(key) || /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  if (/^(?:Control|Shift|Alt|Super)_[LR]$/.test(key)) return key;
  throw new ComputerError("unsupported_key", "Unsupported X11 key name: " + key);
}

export function createLinuxBackend(env: NodeJS.ProcessEnv = process.env, run: typeof runNative = runNative): ComputerBackend {
  if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) return createWaylandBackend(env);
  const xdotool = findExecutable(["xdotool"], env);
  const importer = findExecutable(["import"], env);
  const magick = findExecutable(["magick"], env);
  const loginctl = findExecutable(["loginctl"], env);
  const capture = importer ?? magick;
  async function x(args: string[], ctx: NativeContext, input?: string): Promise<string> {
    if (!xdotool) throw new ComputerError("dependency_missing", "Install xdotool for Linux X11 input.");
    const result = await run({ command: xdotool, args, env, ...(input === undefined ? {} : { input }) }, ctx);
    if (result.exitCode !== 0) throw new ComputerError("x11_command_failed",
      "The X11 server rejected the input/query; check the active desktop and XAUTHORITY.");
    return result.stdout.toString("utf8").trim();
  }
  async function inspect(ctx: NativeContext): Promise<ComputerState> {
    const base: ComputerState = {
      platform: "linux", backend: "linux-x11", available: false, displayKind: "none",
      inputKind: "none", displays: [], actions: [], unicodeText: false,
      permissions: { screenCapture: "unknown", input: "unknown", unlocked: "unknown" }
    };
    if (!env.DISPLAY) return { ...base, reason: "No interactive X11 display is attached to this relay process. Start relay in the desktop user session." };
    if (!xdotool) return { ...base, reason: "Linux X11 input requires xdotool.", details: { missing: ["xdotool"] } };
    if (loginctl && env.XDG_SESSION_ID && /^[a-zA-Z0-9_-]+$/.test(env.XDG_SESSION_ID)) {
      try {
        const locked = await run({ command: loginctl,
          args: ["show-session", env.XDG_SESSION_ID, "--property=LockedHint", "--value"], env }, ctx);
        if (locked.exitCode === 0) {
          const state = locked.stdout.toString("utf8").trim();
          base.permissions.unlocked = state === "yes" ? "denied" : state === "no" ? "granted" : "unknown";
          if (state === "yes") return { ...base, reason: "The desktop session is locked. Unlock it locally to resume control." };
        }
      } catch (error) {
        if (ctx.signal?.aborted || (error instanceof ComputerError && error.code === "timeout")) throw error;
      }
    }
    let geometry: string;
    try { geometry = await x(["getdisplaygeometry"], ctx); }
    catch (error) {
      if (ctx.signal?.aborted || (error instanceof ComputerError && error.code === "timeout")) throw error;
      return { ...base, reason: "The configured X11 display is unavailable or authorization was refused." };
    }
    const match = /^(\d+)\s+(\d+)$/.exec(geometry);
    if (!match) throw new ComputerError("invalid_geometry", "X11 returned invalid display geometry.");
    const width = Number(match[1]), height = Number(match[2]);
    if (width < 1 || height < 1 || width > 32768 || height > 32768) {
      throw new ComputerError("invalid_geometry", "X11 display dimensions are unsupported.");
    }
    let app: ComputerState["app"];
    try {
      const id = await x(["getactivewindow"], ctx);
      if (/^\d+$/.test(id)) app = { id, title: (await x(["getwindowname", id], ctx)).slice(0, 512) };
    } catch (error) {
      if (ctx.signal?.aborted || (error instanceof ComputerError && error.code === "timeout")) throw error;
      // Bare X11 servers can lack an EWMH window manager.
    }
    return {
      ...base, available: true, displayKind: "unknown", inputKind: "mouse_keyboard",
      displays: [{ id: "desktop", x: 0, y: 0, width, height, scaleX: 1, scaleY: 1,
        rotation: 0, primary: true, name: "X11 desktop (all monitors)" }],
      actions: ["move", "click", "drag", "scroll", "key", "text"], unicodeText: true,
      permissions: { ...base.permissions, screenCapture: capture ? "granted" : "denied", input: "granted" },
      ...(app ? { app } : {}),
      ...(!capture ? { reason: "Install ImageMagick (import or magick) for screenshots." } : {}),
      details: { coordinateSpace: "X11 root-window physical pixels", display: env.DISPLAY,
        unicodeMethod: "XTEST temporary key mapping; application keyboard handling may vary" }
    };
  }
  async function requireReady(ctx: NativeContext): Promise<ComputerState> {
    const state = await inspect(ctx);
    if (!state.available) throw new ComputerError("desktop_unavailable", state.reason ?? "X11 desktop unavailable.");
    return state;
  }
  return {
    id: "linux-x11",
    inspect,
    async screenshot(displayId, ctx) {
      const state = await requireReady(ctx);
      if (displayId && displayId !== "desktop") throw new ComputerError("unknown_display", "Choose display desktop.");
      if (!capture) throw new ComputerError("dependency_missing", "Install ImageMagick for PNG screenshots.");
      const args = [...(!importer ? ["import"] : []), "-window", "root", "-silent", "png:-"];
      const result = await run({ command: capture, args, env, maxOutputBytes: 12 * 1024 * 1024 }, ctx);
      if (result.exitCode !== 0) throw new ComputerError("capture_failed", "X11 screenshot capture failed.");
      const dimensions = pngDimensions(result.stdout);
      const display = state.displays[0]!;
      if (dimensions.width !== display.width || dimensions.height !== display.height) {
        throw new ComputerError("display_changed", "The display changed while capturing; take another screenshot.");
      }
      return { data: result.stdout, mimeType: "image/png", display, capturedAt: Date.now(), ...(state.app ? { app: state.app } : {}) };
    },
    async act(action: ComputerAction, display: ComputerDisplay, ctx: NativeContext) {
      const state = await requireReady(ctx);
      const current = state.displays.find(d => d.id === display.id);
      if (!current || current.width !== display.width || current.height !== display.height) {
        throw new ComputerError("display_changed", "The X11 display changed; capture a new frame.");
      }
      let heldButton: number | undefined;
      const heldKeys: string[] = [];
      const cleanup = async () => {
        const safe: NativeContext = { timeoutMs: 1500 };
        const args: string[] = [];
        if (heldButton) args.push("mouseup", String(heldButton));
        if (heldKeys.length) args.push("keyup", ...[...heldKeys].reverse());
        if (args.length) await x(args, safe).catch(() => {});
      };
      try {
        switch (action.type) {
          case "move": {
            const p = nativePoint(display, action.x, action.y);
            await x(["mousemove", String(p.x), String(p.y)], ctx); break;
          }
          case "click": {
            const p = nativePoint(display, action.x, action.y);
            await x(["mousemove", String(p.x), String(p.y)], ctx);
            const button = { left: 1, middle: 2, right: 3 }[action.button ?? "left"];
            for (let i = 0; i < (action.clicks ?? 1); i++) {
              heldButton = button;
              await x(["mousedown", String(button)], ctx);
              await x(["mouseup", String(button)], ctx);
              heldButton = undefined;
              if (i + 1 < (action.clicks ?? 1)) await delay(80, undefined, { signal: ctx.signal });
            }
            break;
          }
          case "drag": {
            const from = nativePoint(display, action.fromX, action.fromY), to = nativePoint(display, action.toX, action.toY);
            await x(["mousemove", String(from.x), String(from.y)], ctx);
            heldButton = 1;
            await x(["mousedown", "1"], ctx);
            const duration = action.durationMs ?? 400, steps = Math.max(2, Math.min(50, Math.ceil(duration / 25)));
            for (let i = 1; i <= steps; i++) {
              await delay(duration / steps, undefined, { signal: ctx.signal });
              await x(["mousemove", String(Math.round(from.x + (to.x - from.x) * i / steps)),
                String(Math.round(from.y + (to.y - from.y) * i / steps))], ctx);
            }
            await x(["mouseup", "1"], ctx); heldButton = undefined; break;
          }
          case "scroll": {
            const args: string[] = [];
            if (action.x !== undefined && action.y !== undefined) {
              const p = nativePoint(display, action.x, action.y); args.push("mousemove", String(p.x), String(p.y));
            }
            args.push("click", "--repeat", String(action.amount ?? 3), "--delay", "25",
              String({ up: 4, down: 5, left: 6, right: 7 }[action.direction]));
            await x(args, ctx); break;
          }
          case "key": {
            const keys = action.keys.map(xKey);
            for (const key of keys) { heldKeys.push(key); await x(["keydown", key], ctx); }
            for (const key of [...keys].reverse()) { await x(["keyup", key], ctx); heldKeys.pop(); }
            break;
          }
          case "text":
            await x(["type", "--delay", "20", "--file", "-"], ctx, action.text); break;
        }
      } finally { await cleanup(); }
      return { submitted: true, verified: false, verification: "Capture the result to verify application behavior.",
        inputBackend: "X11 XTEST" };
    },
    async setup(ctx) { return { state: await inspect(ctx), automaticInstall: false }; }
  };
}
