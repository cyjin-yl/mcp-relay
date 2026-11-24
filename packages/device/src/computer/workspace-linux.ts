import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLinuxBackend } from "./linux.js";
import { findExecutable, nativeEnvironment, runNative } from "./native.js";
import { linuxWorkspaceHelper } from "./workspace-linux-helper.js";
import { writeWorkspaceJson } from "./workspace-state.js";
import { ComputerError, type NativeCommand, type NativeContext, type NativeResult } from "./types.js";
import type { WorkspaceCapabilities, WorkspaceOpenOptions, WorkspaceProvider, WorkspaceProviderContext,
  WorkspaceRecoveryResult, WorkspaceResource } from "./workspace-types.js";

interface GuardianState {
  schema: 1;
  instanceId: string;
  phase: "starting" | "active" | "returning" | "returned" | "empty" | "cleanup_pending";
  display?: string;
  appHomeDirectory?: string;
  appProfileIsolated?: boolean;
  inputRevoked: boolean;
  error?: string;
  recovery?: WorkspaceRecoveryResult;
}
interface LinuxResourceData {
  directory: string;
  runtimeDirectory: string;
  appHomeDirectory?: string;
  secret: string;
  helper: string;
  python: string;
  environment: NodeJS.ProcessEnv;
}
const failure = (code: string, message: string) => new ComputerError(code, message);

function launchProfileOverride(launch: WorkspaceOpenOptions["launch"]): string | undefined {
  if (!launch) return undefined;
  const executable = basename(launch.executable).toLowerCase();
  const mozilla = /^(?:firefox(?:-esr|-beta|-nightly|-developer-edition)?|thunderbird)(?:\.bin)?$/.test(executable);
  const code = /^(?:code(?:-insiders|-oss)?|codium|vscodium|cursor|windsurf)(?:\.bin)?$/.test(executable);
  for (const argument of launch.args) {
    const match = /^--?([^=]+)(?:=|$)/.exec(argument);
    if (!match) continue;
    const option = match[1]!.toLowerCase();
    if (["user-data-dir", "profile-directory", "env:userinstallation"].includes(option)
      || mozilla && ["profile", "p", "remote"].includes(option)
      || code && ["reuse-window", "r"].includes(option)) return match[0]!.replace(/=$/, "");
  }
  return undefined;
}

function resourceData(resource: WorkspaceResource): LinuxResourceData {
  const d = resource.data;
  if (typeof d.directory !== "string" || typeof d.runtimeDirectory !== "string" || typeof d.secret !== "string" || typeof d.helper !== "string"
    || typeof d.python !== "string" || !d.environment || typeof d.environment !== "object") {
    throw failure("workspace_resource_invalid", "Linux workspace ownership record is invalid.");
  }
  return d as unknown as LinuxResourceData;
}
function state(data: LinuxResourceData, resource: WorkspaceResource): GuardianState | undefined {
  try {
    const result = JSON.parse(readFileSync(join(data.directory, "native-state.json"), "utf8")) as GuardianState;
    if (result.schema !== 1 || result.instanceId !== resource.instanceId) {
      throw failure("workspace_resource_invalid", "Linux workspace native instance no longer matches.");
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function linuxWorkspaceRpc<T>(data: Pick<LinuxResourceData, "runtimeDirectory" | "secret">,
  request: Record<string, unknown>, context: NativeContext): Promise<T> {
  context.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(data.runtimeDirectory, "g.sock"));
    let output = Buffer.alloc(0), finished = false;
    const finish = (error?: Error, value?: T) => {
      if (finished) return;
      finished = true; clearTimeout(timer); socket.destroy();
      context.signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(value!);
    };
    const abort = () => finish(failure("cancelled", "Linux workspace operation was cancelled."));
    const timer = setTimeout(() => finish(failure("workspace_native_timeout", "Linux workspace guardian timed out.")),
      Math.min(125000, context.timeoutMs + 2000));
    context.signal?.addEventListener("abort", abort, { once: true });
    socket.on("connect", () => socket.write(JSON.stringify({ ...request, secret: data.secret }) + "\n"));
    socket.on("error", () => finish(failure("workspace_guardian_unavailable", "The independent Linux workspace guardian is unavailable.")));
    socket.on("end", () => { if (!finished) finish(failure("workspace_native_response", "Linux guardian returned no complete receipt.")); });
    socket.on("data", bytes => {
      output = Buffer.concat([output, bytes]);
      if (output.length > 18 * 1024 * 1024) { finish(failure("workspace_native_response", "Linux guardian result exceeds its limit.")); return; }
      const end = output.indexOf(10);
      if (end < 0) return;
      try {
        const message = JSON.parse(output.subarray(0, end).toString("utf8")) as { ok: boolean; result: T; error?: string };
        if (!message.ok) finish(failure("workspace_native_failed", message.error ?? "Linux workspace operation failed."));
        else finish(undefined, message.result);
      } catch { finish(failure("workspace_native_response", "Linux guardian response is invalid.")); }
    });
    if (context.signal?.aborted) abort();
  });
}

export function createLinuxWorkspaceProvider(environment: NodeJS.ProcessEnv = process.env): WorkspaceProvider {
  const env = nativeEnvironment(environment);
  const dependencies: Record<string, string | undefined> = {
    python: findExecutable(["python3"], env), xpra: findExecutable(["xpra"], env),
    Xvfb: findExecutable(["Xvfb"], env), xauth: findExecutable(["xauth"], env),
    xdotool: findExecutable(["xdotool"], env), openbox: findExecutable(["openbox"], env),
    capture: findExecutable(["import", "magick"], env)
  };
  const capabilities: WorkspaceCapabilities = {
    available: false, isolated: true, canAdoptWindows: false, recovery: "handoff-viewer",
    independentWatchdog: true, unicodeText: true, clipboardBoundary: "isolated",
    details: { mode: "private-x11-server", physicalMonitorTopologyChanged: false,
      existingWindowMigration: "unsupported", clipboardBoundary: "isolated",
      applicationProfiles: "persistent private HOME and XDG directories per workspace; explicit shared-profile/reuse overrides are rejected",
      handoff: "preserve applications in an Xpra viewer on the original physical desktop",
      setup: "Install xpra, xvfb, xauth, xdotool, openbox, ImageMagick, python3-xlib and python3-pil; run relay from the desktop user session." }
  };
  async function probe(ctx: NativeContext): Promise<WorkspaceCapabilities> {
    if (process.platform !== "linux") return { ...capabilities, reason: "This provider requires Linux." };
    const missing = Object.entries(dependencies).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) return { ...capabilities, reason: "Linux isolated workspace dependencies are missing: " + missing.join(", "),
      details: { ...capabilities.details, missing } };
    if (!env.DISPLAY) return { ...capabilities,
      reason: "No physical desktop is available for returning applications. Start relay in an X11 or XWayland desktop session." };
    try {
      const imports = await runNative({ command: dependencies.python!, args: ["-c", "import Xlib, Xlib.ext.xtest, PIL.Image"], env }, ctx);
      if (imports.exitCode) return { ...capabilities, reason: "Install python3-xlib and python3-pil for independent input release and a working Xpra recovery viewer." };
      const desktop = await runNative({ command: dependencies.xdotool!, args: ["getdisplaygeometry"], env }, ctx);
      if (desktop.exitCode !== 0 || !/^\d+\s+\d+\s*$/.test(desktop.stdout.toString())) {
        return { ...capabilities, reason: "The physical desktop cannot be verified for visible recovery." };
      }
      // Recovery places the retained viewer inside an actual active monitor,
      // including layouts whose Xroot contains gaps. Verify that exact RandR
      // operation before launching an app that may need a visible handoff.
      const monitors = await runNative({ command: dependencies.python!, args: ["-c",
        "from Xlib import display; d=display.Display(); " +
        "monitors=d.screen().root.xrandr_get_monitors(True).monitors; " +
        "print('verified' if any(int(m.width_in_pixels)>100 and int(m.height_in_pixels)>100 for m in monitors) else 'unavailable'); d.close()"
      ], env }, ctx);
      if (monitors.exitCode !== 0 || monitors.stdout.toString().trim() !== "verified") {
        return { ...capabilities, reason: "No readable active RandR monitor is available for verifying a visible recovery viewer." };
      }
      return { ...capabilities, available: true };
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      return { ...capabilities, reason: "The physical desktop or Linux native dependencies are not available." };
    }
  }
  function backend(resource: WorkspaceResource) {
    const data = resourceData(resource), current = state(data, resource);
    if (!current || current.phase !== "active" || !current.display || current.inputRevoked) {
      throw failure("workspace_input_revoked", "Linux workspace is no longer accepting computer actions.");
    }
    const privateEnv: NodeJS.ProcessEnv = { ...data.environment, DISPLAY: current.display, XAUTHORITY: join(data.directory, "Xauthority"),
      XDG_SESSION_TYPE: "x11" };
    delete privateEnv.WAYLAND_DISPLAY; delete privateEnv.DBUS_SESSION_BUS_ADDRESS; delete privateEnv.XDG_SESSION_ID;
    const runner = async (spec: NativeCommand, ctx: NativeContext): Promise<NativeResult> => {
      const result = await linuxWorkspaceRpc<{ stdout: string; stderr: string; exitCode: number }>(data, {
        operation: "execute", command: spec.command, args: spec.args, timeoutMs: ctx.timeoutMs,
        ...(spec.input === undefined ? {} : { input: Buffer.from(spec.input).toString("base64") })
      }, ctx);
      return { stdout: Buffer.from(result.stdout, "base64"), stderr: Buffer.from(result.stderr, "base64"), exitCode: result.exitCode };
    };
    return createLinuxBackend(privateEnv, runner);
  }
  return {
    id: "linux-xpra-workspace",
    probe,
    async open(options, ctx) {
      if (existsSync(ctx.revocationPath)) throw failure("workspace_closed", "Workspace creation was revoked.");
      const override = launchProfileOverride(options.launch);
      if (override) throw failure("workspace_launch_override_unsupported",
        "Isolated Linux launch cannot use " + override + " to select an existing profile or instance. " +
        "Remove the override for a private workspace profile, or choose foreground mode explicitly.");
      const checked = await probe(ctx);
      if (!checked.available) throw failure("isolated_workspace_unavailable", checked.reason!);
      const directory = join(ctx.journalDirectory, "linux-native");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const helper = join(directory, "guardian.py");
      writeFileSync(helper, linuxWorkspaceHelper, { mode: 0o600, flag: "wx" });
      // Linux AF_UNIX names have a short fixed limit. Durable journals can be
      // arbitrarily deep, so IPC alone uses a fresh private 0700 runtime path.
      const runtimeDirectory = mkdtempSync("/tmp/relay-ws-");
      const data: LinuxResourceData = { directory, runtimeDirectory, appHomeDirectory: join(directory, "app-home"),
        secret: randomBytes(32).toString("hex"), helper,
        python: dependencies.python!, environment: env };
      const resource: WorkspaceResource = {
        providerId: "linux-xpra-workspace", leaseId: options.leaseId, instanceId: randomUUID(),
        display: { id: "desktop", x: 0, y: 0, width: options.width, height: options.height,
          scaleX: 1, scaleY: 1, primary: false, name: "Relay isolated Linux desktop" },
        data: data as unknown as WorkspaceResource["data"]
      };
      resource.display.instanceId = resource.instanceId;
      await ctx.checkpoint(resource);
      await writeWorkspaceJson(join(directory, "config.json"), {
        schema: 1, instanceId: resource.instanceId, secret: data.secret, environment: env, revocationPath: ctx.revocationPath,
        runtimeDirectory,
        tools: dependencies, width: options.width, height: options.height,
        expiresAt: options.expiresAt, hardExpiresAt: options.hardExpiresAt,
        ...(options.launch ? { launch: options.launch } : {})
      });
      const child = spawn(dependencies.python!, [helper, join(directory, "config.json")],
        { detached: true, stdio: "ignore", env, shell: false });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () => reject(failure("workspace_guardian_start_failed", "Could not start the independent Linux recovery guardian.")));
      });
      child.unref();
      const end = Date.now() + Math.min(ctx.timeoutMs, 45000);
      while (Date.now() < end) {
        ctx.signal?.throwIfAborted();
        const current = state(data, resource);
        if (current?.phase === "active") {
          if (current.appHomeDirectory !== data.appHomeDirectory || current.appProfileIsolated !== true) {
            throw failure("workspace_resource_invalid", "Linux workspace private application profile was not verified.");
          }
          await linuxWorkspaceRpc(data, { operation: "renew", expiresAt: options.expiresAt }, { ...ctx, timeoutMs: 3000 });
          await ctx.checkpoint(resource);
          return resource;
        }
        if (current && current.phase !== "starting") {
          throw failure("workspace_open_failed", current.error ?? "Linux desktop creation failed; native recovery is active.");
        }
        await delay(100, undefined, { signal: ctx.signal });
      }
      throw failure("workspace_open_failed", "Linux desktop creation timed out; independent recovery remains active.");
    },
    async renew(resource, expiresAt, ctx) {
      await linuxWorkspaceRpc(resourceData(resource), { operation: "renew", expiresAt }, ctx);
    },
    async inspect(resource, ctx) {
      const result = await backend(resource).inspect(ctx);
      return { ...result, backend: "linux-xpra-workspace", displayKind: "virtual",
        displays: result.displays.map(display => ({ ...display, instanceId: resource.instanceId, primary: false })),
        details: { ...result.details, isolation: "private X11 server", clipboardBoundary: "isolated",
          physicalInputShared: false, handoff: "Xpra viewer on the original physical desktop" } };
    },
    async capture(resource, ctx) {
      const result = await backend(resource).screenshot("desktop", ctx);
      return { ...result, display: { ...result.display, instanceId: resource.instanceId, primary: false } };
    },
    async act(resource, action, ctx) {
      return backend(resource).act(action, resource.display, ctx);
    },
    async recover(resource, _options, reason, ctx: WorkspaceProviderContext) {
      if (!resource) return { complete: true, outcome: "no-resources", inputRevoked: true, ownedDisplayRemoved: true };
      const data = resourceData(resource);
      await writeWorkspaceJson(join(data.directory, "revoked.json"), { reason, at: Date.now() });
      const current = state(data, resource);
      if (current?.recovery?.complete) return current.recovery;
      try {
        const result = await linuxWorkspaceRpc<WorkspaceRecoveryResult | null>(data, { operation: "recover", reason }, ctx);
        if (result) return result;
      } catch {
        // The guardian itself may have been killed. Reconciliation uses its
        // durable exact process identities; never target a reused display ID.
        if (existsSync(join(data.directory, "config.json"))) {
          await runNative({ command: data.python, args: [data.helper, join(data.directory, "config.json"), "--recover"], env }, { timeoutMs: 15000 })
            .catch(() => {});
        }
      }
      return state(data, resource)?.recovery ?? { complete: false, outcome: "cleanup-pending",
        inputRevoked: true, ownedDisplayRemoved: false, details: { reason: "Awaiting native Linux recovery receipt." } };
    }
  };
}