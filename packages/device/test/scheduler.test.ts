import { afterEach, describe, expect, it, vi } from "vitest";
import { CallCancelledError, CallScheduler, CallTimeoutError } from "../src/scheduler.js";

afterEach(() => vi.useRealTimers());

describe("device call scheduling", () => {
  it("lets reads finish during a long shell but preserves mutation order", async () => {
    const scheduler = new CallScheduler<string>();
    const hold = Promise.withResolvers<string>();
    const order: string[] = [];
    const first = scheduler.schedule("shell", false, 1000, () => { order.push("shell"); return hold.promise; });
    const second = scheduler.schedule("edit", false, 1000, async () => { order.push("edit"); return "edited"; });
    expect(await scheduler.schedule("read", true, 1000, async () => "read result")).toBe("read result");
    expect(order).toEqual(["shell"]);
    hold.resolve("done");
    await expect(first).resolves.toBe("done");
    await expect(second).resolves.toBe("edited");
    expect(order).toEqual(["shell", "edit"]);
    scheduler.close();
  });

  it("never invokes a mutation that expired in the queue", async () => {
    vi.useFakeTimers();
    const scheduler = new CallScheduler<string>();
    const hold = Promise.withResolvers<string>();
    const first = scheduler.schedule("shell", false, 1000, () => hold.promise);
    const write = vi.fn(async () => "secretly wrote");
    const expired = scheduler.schedule("expired-write", false, 20, write).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await expired).toBeInstanceOf(CallTimeoutError);
    hold.resolve("done");
    await first;
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
    scheduler.close();
  });

  it("keeps the writer lane occupied until an aborted executor actually stops", async () => {
    vi.useFakeTimers();
    const scheduler = new CallScheduler<string>();
    const hold = Promise.withResolvers<string>();
    let aborted = false;
    const old = scheduler.schedule("old", false, 20, (signal) => {
      signal.addEventListener("abort", () => { aborted = true; });
      return hold.promise;
    }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);
    expect(await old).toBeInstanceOf(CallTimeoutError);
    expect(aborted).toBe(true);
    const nextWrite = vi.fn(async () => "next");
    const next = scheduler.schedule("next", false, 1000, nextWrite);
    await vi.advanceTimersByTimeAsync(1);
    expect(nextWrite).not.toHaveBeenCalled();
    hold.resolve("late result");
    await expect(next).resolves.toBe("next");
    scheduler.close();
  });

  it("cancels queued work and preserves the shared lane for a new connection", async () => {
    const scheduler = new CallScheduler<string>();
    const hold = Promise.withResolvers<string>();
    const old = scheduler.schedule("old-connection", false, 1000, () => hold.promise).catch((error) => error);
    const oldQueued = vi.fn(async () => "stale");
    const queued = scheduler.schedule("old-queued", false, 1000, oldQueued).catch((error) => error);
    scheduler.cancel("old-queued");
    scheduler.cancel("old-connection");
    expect(await old).toBeInstanceOf(CallCancelledError);
    expect(await queued).toBeInstanceOf(CallCancelledError);
    const newWrite = vi.fn(async () => "new");
    const next = scheduler.schedule("new-connection", false, 1000, newWrite);
    expect(newWrite).not.toHaveBeenCalled();
    hold.resolve("old stopped");
    await expect(next).resolves.toBe("new");
    expect(oldQueued).not.toHaveBeenCalled();
    scheduler.close();
  });

  it("bounds concurrent reads and rejects overload instead of growing an unbounded queue", async () => {
    const scheduler = new CallScheduler<string>(2, 3);
    const a = Promise.withResolvers<string>(), b = Promise.withResolvers<string>();
    const first = scheduler.schedule("a", true, 1000, () => a.promise);
    const second = scheduler.schedule("b", true, 1000, () => b.promise);
    const thirdCall = vi.fn(async () => "c");
    const third = scheduler.schedule("c", true, 1000, thirdCall);
    await expect(scheduler.schedule("d", true, 1000, async () => "d")).rejects.toThrow("busy");
    expect(thirdCall).not.toHaveBeenCalled();
    a.resolve("a");
    await first;
    expect(await third).toBe("c");
    b.resolve("b");
    await second;
    scheduler.close();
  });
});
