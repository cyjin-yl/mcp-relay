import { existsSync } from "node:fs";
import { createLinuxBackend } from "./linux.js";
import { createPveBackend } from "./pve.js";
import { ComputerError, type ComputerBackend, type ComputerState, type NativeContext } from "./types.js";

export interface LinuxHostBackendOptions {
  env?: NodeJS.ProcessEnv;
  desktop?: ComputerBackend;
  /** null explicitly disables VM discovery, principally for standalone/native tests. */
  pve?: ComputerBackend | null;
}

/** Keep the host desktop while exposing each local PVE VM as a separate target. */
export function createLinuxHostBackend(options: LinuxHostBackendOptions = {}): ComputerBackend {
  const desktop = options.desktop ?? createLinuxBackend(options.env);
  const pve = options.pve === undefined
    ? (existsSync("/usr/sbin/qm") ? createPveBackend() : undefined)
    : options.pve;
  if (!pve) return desktop;

  const virtual = (id: string | undefined) => id?.startsWith("pve:") === true;
  async function discover(backend: ComputerBackend, context: NativeContext): Promise<ComputerState> {
    context.signal?.throwIfAborted();
    try { return await backend.inspect(context); }
    catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof ComputerError && ["timeout", "cancelled"].includes(error.code)) throw error;
      return {
        platform: "linux", backend: backend.id, available: false, displayKind: "none", inputKind: "none",
        displays: [], actions: [], unicodeText: false, permissions: { access: "unknown" },
        reason: error instanceof ComputerError ? error.message : "This console provider could not be inspected.",
        details: { inspectionError: error instanceof ComputerError ? error.code : "inspection_failed" }
      };
    }
  }
  async function inspect(context: NativeContext, displayId?: string): Promise<ComputerState> {
    if (virtual(displayId)) return pve!.inspect(context, displayId);
    if (displayId !== undefined) return desktop.inspect(context, displayId);
    const host = await discover(desktop, context);
    const machines = await discover(pve!, context);
    const available = [host, machines].filter(state => state.available);
    const permissions: ComputerState["permissions"] = {};
    for (const [prefix, state] of [["host", host], ["pve", machines]] as const) {
      for (const [name, value] of Object.entries(state.permissions)) permissions[prefix + "." + name] = value;
    }
    return {
      platform: "linux", backend: "linux-host+pve-qmp", available: available.length > 0,
      displayKind: available.length === 1 ? available[0]!.displayKind : available.length > 1 ? "unknown" : "none",
      inputKind: available.some(state => state.inputKind === "mouse_keyboard") ? "mouse_keyboard" : "none",
      displays: [...host.displays, ...machines.displays],
      actions: [...new Set(available.flatMap(state => state.actions))],
      // Untargeted discovery is conservative; targeted inspect returns the
      // selected provider's actual text capability.
      unicodeText: available.length > 0 && available.every(state => state.unicodeText), permissions,
      ...(available.length === 0 ? { reason: "Neither the host desktop nor a local PVE VM console is currently available." } : {}),
      details: {
        ...(machines.details ?? {}),
        targetSelection: "Select display_id pve:<VMID> for a VM, or a host desktop ID. VM actions remain bound to their captured frame.",
        hostDesktop: host,
        pve: { backend: machines.backend, available: machines.available, permissions: machines.permissions,
          ...(machines.reason ? { reason: machines.reason } : {}) }
      }
    };
  }
  return {
    id: "linux-host+pve-qmp", inspect, setupInWorker: desktop.setupInWorker,
    close: async () => { await Promise.all([desktop.close?.(), pve?.close?.()]); },
    async screenshot(displayId, context) {
      if (virtual(displayId)) return pve!.screenshot(displayId, context);
      if (displayId !== undefined) return desktop.screenshot(displayId, context);
      const host = await discover(desktop, context);
      if (host.available) return desktop.screenshot(undefined, context);
      // The VM provider requires an explicit target when several VMs exist;
      // a desktop failure must never pick a random guest.
      return pve!.screenshot(undefined, context);
    },
    async act(action, display, context) {
      return (virtual(display.id) ? pve! : desktop).act(action, display, context);
    },
    async setup(context) {
      const setup = desktop.setup ? await desktop.setup(context) : {};
      return { ...setup, state: await inspect(context), automaticInstall: false };
    }
  };
}
