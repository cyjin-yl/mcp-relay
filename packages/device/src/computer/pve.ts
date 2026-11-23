import { findExecutable, pngDimensions, runNative } from "./native.js";
import { PVE_HELPER } from "./pve-helper.js";
import { ComputerError, type CapturedScreen, type ComputerAction, type ComputerBackend,
  type ComputerDisplay, type ComputerState, type NativeContext } from "./types.js";

export interface PveBackendRuntime {
  env?: NodeJS.ProcessEnv;
  find?: typeof findExecutable;
  run?: typeof runNative;
  uid?: () => number;
}

interface VmTarget {
  vmid: number;
  displayId: string;
  name: string;
  status: string;
  graphicalConsole: "available" | "none" | "unknown";
  inputAvailable: boolean;
  absolutePointer?: boolean;
  qmpPermission?: "granted" | "denied" | "unknown";
  reason?: string;
}

interface VmScreen {
  vmid: number;
  identity: string;
  status: string;
  running: boolean;
  absolutePointer: boolean;
  width: number;
  height: number;
  capturedAt: number;
  pngBase64?: string;
  console?: { device: string; head: number; console: string };
}

const aliases: Record<string, string> = {
  control: "ctrl", ctrl: "ctrl", control_l: "ctrl", control_r: "ctrl_r",
  alt: "alt", option: "alt", alt_l: "alt", alt_r: "alt_r",
  shift: "shift", shift_l: "shift", shift_r: "shift_r",
  meta: "meta_l", super: "meta_l", win: "meta_l", command: "meta_l", super_l: "meta_l", super_r: "meta_r",
  enter: "ret", return: "ret", escape: "esc", esc: "esc", tab: "tab", backspace: "backspace",
  delete: "delete", insert: "insert", space: "spc", home: "home", end: "end",
  pageup: "pgup", pagedown: "pgdn", up: "up", down: "down", left: "left", right: "right",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right",
  capslock: "caps_lock", numlock: "num_lock", scrolllock: "scroll_lock", printscreen: "print", pause: "pause"
};
const modifierKeys = new Set(["ctrl", "ctrl_r", "alt", "alt_r", "shift", "shift_r", "meta_l", "meta_r"]);
const extendedKeys = new Set(["ctrl_r", "alt_r", "meta_l", "meta_r", "delete", "insert", "home", "end", "pgup", "pgdn", "up", "down", "left", "right", "print"]);

export function pveKeyChord(keys: string[]): string[] {
  const mapped = keys.map(key => {
    const lower = key.toLowerCase();
    const result = aliases[lower] ?? (/^[a-z0-9]$/.test(lower) || /^f(?:[1-9]|1[0-2])$/.test(lower) ? lower : undefined);
    if (!result) throw new ComputerError("unsupported_key", "Unsupported PVE key name: " + key);
    return result;
  });
  if (mapped.length < 1 || mapped.length > 8 || new Set(mapped).size !== mapped.length) {
    throw new ComputerError("unsupported_key", "A PVE chord must contain 1–8 distinct supported keys.");
  }
  // QEMU ui/input-keymap.c emits 1 ordinary, 2 extended or 3 Pause scan
  // codes per edge. HID has 16 FIFO slots and six non-modifier rollover.
  // Keep this conservative admission in sync with the isolated helper.
  const scanCost = 2 * mapped.reduce((sum, key) => sum + (key === "pause" ? 3 : extendedKeys.has(key) ? 2 : 1), 0);
  if (scanCost > 16 || mapped.filter(key => !modifierKeys.has(key)).length > 6) {
    throw new ComputerError("unsupported_key", "This PVE key chord exceeds the guest keyboard's bounded FIFO or six-key rollover limit.", { mayHaveApplied: false });
  }
  return mapped;
}

export function pveVmId(displayId: string): number {
  const match = /^pve:([1-9][0-9]{0,8})$/.exec(displayId);
  const value = match ? Number(match[1]) : 0;
  if (value < 100 || value > 999999999) throw new ComputerError("invalid_vm_id", "Choose a display_id returned by computer_info, for example pve:100.");
  return value;
}

function display(screen: VmScreen): ComputerDisplay {
  if (!Number.isInteger(screen.width) || !Number.isInteger(screen.height) || screen.width < 1 || screen.height < 1
    || screen.width > 32768 || screen.height > 32768 || screen.width * screen.height > 120000000
    || !screen.identity?.startsWith("pve:" + screen.vmid + ":")) {
    throw new ComputerError("invalid_screenshot_geometry", "PVE returned an invalid display or process identity.");
  }
  return { id: "pve:" + screen.vmid, instanceId: screen.identity, name: "VM " + screen.vmid + " · QEMU console",
    x: 0, y: 0, width: screen.width, height: screen.height, scaleX: 1, scaleY: 1, rotation: 0, primary: true };
}

export function createPveBackend(runtime: PveBackendRuntime = {}): ComputerBackend {
  const env = runtime.env ?? process.env;
  const find = runtime.find ?? findExecutable;
  const run = runtime.run ?? runNative;
  const uid = runtime.uid ?? (() => process.getuid?.() ?? -1);
  const qm = find(["/usr/sbin/qm"], env);
  const pvesh = find(["/usr/bin/pvesh"], env);
  const python = find(["/usr/bin/python3", "python3"], env);
  const sudo = find(["/usr/bin/sudo", "sudo"], env);
  const base = (): ComputerState => ({ platform: "linux", backend: "pve-qmp", available: false,
    displayKind: "virtual", inputKind: "none", displays: [], actions: [], unicodeText: false,
    permissions: { pveHost: qm && pvesh ? "granted" : "denied", qmp: "unknown", screenCapture: "unknown", input: "unknown" },
    details: { guestAgentRequired: false, textMethod: "printable ASCII via US keyboard scan codes; guest layout and application handling may vary",
      targetFormat: "pve:<VMID>", consoleSelection: "first live graphical console", scrollDirections: ["up", "down"], hostDesktopIncluded: false } });

  async function invoke<T>(request: Record<string, unknown>, context: NativeContext): Promise<T> {
    if (!qm || !pvesh) throw new ComputerError("pve_unavailable", "PVE host tools /usr/sbin/qm and /usr/bin/pvesh are unavailable.");
    if (!python) throw new ComputerError("dependency_missing", "PVE computer control requires Python 3.");
    if (uid() !== 0 && !sudo) throw new ComputerError("pve_privilege_required", "Run the relay as root or grant non-interactive sudo access to the PVE helper.");
    const privileged = uid() !== 0;
    const result = await run({ command: privileged ? sudo! : python,
      args: [...(privileged ? ["-n", "--", python] : []), "-I", "-c", PVE_HELPER], env,
      input: JSON.stringify({ ...request, timeoutMs: Math.max(1, Math.min(120000, Math.floor(context.timeoutMs))) }),
      maxOutputBytes: request.operation === "screenshot" ? 17 * 1024 * 1024 : 2 * 1024 * 1024 }, context);
    let value: { ok?: boolean; code?: string; message?: string; details?: Record<string, unknown> };
    try { value = JSON.parse(result.stdout.toString("utf8")) as typeof value; }
    catch { throw new ComputerError(privileged && result.exitCode !== 0 ? "pve_privilege_required" : "pve_helper_failed",
      privileged && result.exitCode !== 0 ? "Non-interactive sudo refused the PVE helper; no password prompt is opened." : "PVE helper returned no valid result."); }
    if (!value || typeof value !== "object" || value.ok !== true) {
      throw new ComputerError(value?.code ?? "pve_helper_failed", value?.message ?? "PVE helper did not confirm the operation.", value?.details);
    }
    if (result.exitCode !== 0) throw new ComputerError("pve_helper_failed", "PVE helper did not exit successfully.");
    return value as T;
  }

  async function choose(displayId: string | undefined, context: NativeContext): Promise<number> {
    if (displayId !== undefined) return pveVmId(displayId);
    const inventory = await invoke<{ virtualMachines: VmTarget[] }>({ operation: "inventory" }, context);
    const candidates = inventory.virtualMachines.filter(vm => vm.graphicalConsole === "available");
    if (inventory.virtualMachines.length !== 1 || candidates.length !== 1) throw new ComputerError("display_required", "Choose an explicit PVE VM display_id from computer_info; no VM was selected automatically.");
    return candidates[0]!.vmid;
  }

  async function inspect(context: NativeContext, displayId?: string): Promise<ComputerState> {
    const state = base();
    try {
      if (displayId === undefined) {
        const inventory = await invoke<{ virtualMachines: VmTarget[] }>({ operation: "inventory" }, context);
        const permissions = inventory.virtualMachines.filter(vm => vm.status !== "stopped").map(vm => vm.qmpPermission ?? "unknown");
        const qmp = permissions.includes("granted") ? "granted" : permissions.length > 0 && permissions.every(value => value === "denied") ? "denied" : "unknown";
        return { ...state, available: true, inputKind: "mouse_keyboard", reason: "Select an explicit pve:<VMID> target to inspect its live display and input capabilities.",
          permissions: { ...state.permissions, qmp }, details: { ...state.details, virtualMachines: inventory.virtualMachines } };
      }
      const screen = await invoke<VmScreen>({ operation: "inspect", vmid: pveVmId(displayId) }, context);
      const actions: ComputerState["actions"] = screen.running ? ["key", "text"] : [];
      if (screen.running && screen.absolutePointer) actions.unshift("move", "click", "drag", "scroll");
      return { ...state, available: screen.running, inputKind: "mouse_keyboard", displays: [display(screen)], actions,
        app: { id: screen.identity, title: "VM " + screen.vmid },
        permissions: { ...state.permissions, qmp: "granted", screenCapture: "granted", input: screen.running ? "granted" : "denied" },
        ...(!screen.running ? { reason: "VM is " + screen.status + "; screenshots remain available but input is disabled." }
          : !screen.absolutePointer ? { reason: "Keyboard input is available; coordinate input requires a current absolute pointing device." } : {}),
        details: { ...state.details, vmid: screen.vmid, status: screen.status, absolutePointer: screen.absolutePointer, console: screen.console } };
    } catch (error) {
      if (context.signal?.aborted || (error instanceof ComputerError && ["cancelled", "timeout"].includes(error.code))) throw error;
      if (!(error instanceof ComputerError)) throw error;
      return { ...state, reason: error.message, details: { ...state.details, code: error.code },
        permissions: { ...state.permissions, qmp: error.code === "pve_privilege_required" ? "denied" : "unknown" } };
    }
  }

  return {
    id: "pve-qmp", inspect,
    async setup(context) { return { state: await inspect(context), automaticInstall: false, guestAgentRequired: false }; },
    async screenshot(displayId, context): Promise<CapturedScreen> {
      const vmid = await choose(displayId, context);
      const screen = await invoke<VmScreen>({ operation: "screenshot", vmid }, context);
      if (typeof screen.pngBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(screen.pngBase64)) {
        throw new ComputerError("invalid_screenshot", "PVE returned no valid PNG payload.");
      }
      const data = Buffer.from(screen.pngBase64, "base64");
      const size = pngDimensions(data);
      if (size.width !== screen.width || size.height !== screen.height) throw new ComputerError("invalid_screenshot_geometry", "PVE image and display geometry differ.");
      return { data, mimeType: "image/png", display: display(screen), capturedAt: screen.capturedAt,
        app: { id: screen.identity, title: "VM " + vmid } };
    },
    async act(action: ComputerAction, target: ComputerDisplay, context: NativeContext) {
      const vmid = pveVmId(target.id);
      if (typeof target.instanceId !== "string" || !target.instanceId.startsWith("pve:" + vmid + ":")) {
        throw new ComputerError("vm_identity_invalid", "PVE input requires a fresh frame bound to this VM process.");
      }
      let nativeAction: ComputerAction = action;
      if (action.type === "key") nativeAction = { ...action, keys: pveKeyChord(action.keys) };
      if (action.type === "text" && (action.text.length > 16384 || /[^\x20-\x7e]/.test(action.text))) {
        throw new ComputerError("unsupported_text", "PVE text supports printable ASCII with a US guest keyboard layout. Unicode, Enter, Tab, and other control characters are not typed implicitly.");
      }
      if (action.type === "scroll" && action.direction !== "up" && action.direction !== "down") {
        throw new ComputerError("unsupported_action", "PVE console scrolling supports only up and down; horizontal wheel events are not delivered by the standard QEMU tablet.", { mayHaveApplied: false });
      }
      const releaseButton = action.type === "drag" ? "left" : action.type === "click" ? action.button ?? "left" : undefined;
      let failure: unknown;
      try {
        await invoke({ operation: "action", vmid, expectedIdentity: target.instanceId,
          width: target.width, height: target.height, action: nativeAction }, context);
      } catch (error) { failure = error; }
      finally {
        if (releaseButton && !(failure instanceof ComputerError && failure.details?.mayHaveApplied === false)) {
          try { await invoke({ operation: "release", vmid, expectedIdentity: target.instanceId, button: releaseButton }, { timeoutMs: 1500 }); }
          catch (error) {
            // A changed/stopped VM cannot retain this process's held input. Do
            // not send releases to its replacement. Other failures are honest.
            if (!(error instanceof ComputerError) || !["vm_changed", "vm_offline"].includes(error.code)) {
              failure = new ComputerError("input_cleanup_failed", "Could not confirm release of the VM pointer button; observe the VM before continuing.", { mayHaveApplied: true });
            }
          }
        }
      }
      if (failure) throw failure;
      return { backend: "pve-qmp", vmid, instanceId: target.instanceId, unicodeText: false,
        verification: "QEMU accepted the input events; verify the guest result with a fresh screenshot.",
        ...(action.type === "text" ? { keyboardLayout: "US", textMethod: "printable ASCII key events" } : {}) };
    }
  };
}
