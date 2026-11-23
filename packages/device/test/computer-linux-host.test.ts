import { describe, expect, it, vi } from "vitest";
import { createLinuxHostBackend } from "../src/computer/linux-host.js";
import { ComputerError, type ComputerBackend, type ComputerState } from "../src/computer/types.js";

const context = { timeoutMs: 3000 };
function backend(id: string, displayId: string, available = true) {
  const display = { id: displayId, x: 0, y: 0, width: 10, height: 10 };
  const state: ComputerState = {
    platform: "linux", backend: id, available, displayKind: "virtual", inputKind: "mouse_keyboard",
    displays: available ? [display] : [], actions: ["click", "text"], unicodeText: id === "desktop",
    permissions: { input: available ? "granted" : "denied" },
    details: id === "pve" ? { virtualMachines: [{ vmid: 101, status: "running" }, { vmid: 102, status: "stopped" }] } : {}
  };
  const inspect = vi.fn(async () => state);
  const screenshot = vi.fn(async () => ({ data: Buffer.alloc(0), mimeType: "image/png" as const,
    display, capturedAt: Date.now() }));
  const act = vi.fn(async () => ({ submitted: true }));
  const provider: ComputerBackend = { id, inspect, screenshot, act };
  return { provider, inspect, screenshot, act, state, display };
}

describe("Linux host and PVE target routing", () => {
  it("discovers VMs without replacing the native host desktop or taking screenshots", async () => {
    const desktop = backend("desktop", "desktop"), pve = backend("pve", "pve:101");
    const host = createLinuxHostBackend({ desktop: desktop.provider, pve: pve.provider });
    const state = await host.inspect(context);
    expect(state.displays.map(display => display.id)).toEqual(["desktop", "pve:101"]);
    expect(state.details?.virtualMachines).toEqual(pve.state.details?.virtualMachines);
    expect(state.unicodeText).toBe(false);
    expect(desktop.screenshot).not.toHaveBeenCalled();
    expect(pve.screenshot).not.toHaveBeenCalled();
    await host.screenshot(undefined, context);
    expect(desktop.screenshot).toHaveBeenCalledOnce();
    expect(pve.screenshot).not.toHaveBeenCalled();
  });
  it("explicit VM observation and input never touch the host desktop", async () => {
    const desktop = backend("desktop", "desktop"), pve = backend("pve", "pve:101");
    const host = createLinuxHostBackend({ desktop: desktop.provider, pve: pve.provider });
    await host.inspect(context, "pve:101");
    await host.screenshot("pve:101", context);
    await host.act({ type: "click", x: 3, y: 4 }, pve.display, context);
    expect(pve.inspect).toHaveBeenCalledWith(context, "pve:101");
    expect(pve.screenshot).toHaveBeenCalledWith("pve:101", context);
    expect(pve.act).toHaveBeenCalledOnce();
    expect(desktop.inspect).not.toHaveBeenCalled();
    expect(desktop.screenshot).not.toHaveBeenCalled();
    expect(desktop.act).not.toHaveBeenCalled();
  });
  it("does not fall back to a different target after a selected VM fails", async () => {
    const desktop = backend("desktop", "desktop"), pve = backend("pve", "pve:101");
    pve.screenshot.mockRejectedValue(new ComputerError("vm_stopped", "VM is stopped."));
    const host = createLinuxHostBackend({ desktop: desktop.provider, pve: pve.provider });
    await expect(host.screenshot("pve:101", context)).rejects.toMatchObject({ code: "vm_stopped" });
    expect(desktop.inspect).not.toHaveBeenCalled();
    expect(desktop.screenshot).not.toHaveBeenCalled();
  });
  it("keeps explicit selection errors when no host desktop exists", async () => {
    const desktop = backend("desktop", "desktop", false), pve = backend("pve", "pve:101");
    pve.screenshot.mockRejectedValue(new ComputerError("display_required", "Choose a VM."));
    const host = createLinuxHostBackend({ desktop: desktop.provider, pve: pve.provider });
    await expect(host.screenshot(undefined, context)).rejects.toMatchObject({ code: "display_required" });
    expect(desktop.screenshot).not.toHaveBeenCalled();
  });
  it("VM permission failures do not hide an independently available host desktop", async () => {
    const desktop = backend("desktop", "desktop"), pve = backend("pve", "pve:101");
    pve.inspect.mockRejectedValue(new ComputerError("permission_denied", "Host access is required."));
    const host = createLinuxHostBackend({ desktop: desktop.provider, pve: pve.provider });
    expect((await host.inspect(context)).available).toBe(true);
    await expect(host.inspect(context, "pve:101")).rejects.toMatchObject({ code: "permission_denied" });
  });
  it("does not mask cancellation as unavailable VM inventory", async () => {
    const desktop = backend("desktop", "desktop"), pve = backend("pve", "pve:101");
    const host = createLinuxHostBackend({ desktop: desktop.provider, pve: pve.provider });
    const signal = AbortSignal.abort();
    await expect(host.inspect({ ...context, signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(pve.inspect).not.toHaveBeenCalled();
  });
});
