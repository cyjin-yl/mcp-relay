import { describe, expect, it, vi } from "vitest";
import { FixtureWaitTimeoutError, waitForFixture, type FixtureWaitOptions, type FixtureWaitProgress,
  type FixtureWaitState, type OwnerFixtureWaitStage } from "./manual/windows-workspace-fixture-wait.js";

const NOW = 100000;
const NONCE = "owned-validation-nonce";
const EXPECTED_TEXT = "你好，隔离桌面🙂";
type OwnerOptions = Extract<FixtureWaitOptions<FixtureWaitState>, { stage: OwnerFixtureWaitStage }>;
function fixture(changes: Partial<FixtureWaitState> = {}): FixtureWaitState {
  return { nonce: NONCE, session: 2, closed: false, text: "", clicks: 0, warps: 0, ...changes };
}
function harness(changes: Partial<OwnerOptions> = {}) {
  let now = NOW;
  const events: FixtureWaitProgress[] = [];
  const options: OwnerOptions = {
    stage: "fixture-ready", nonce: NONCE, session: 2, expectedText: EXPECTED_TEXT,
    expiresAt: NOW + 120000, hardExpiresAt: NOW + 150000, assertHeartbeat: vi.fn(),
    read: vi.fn(async () => undefined), predicate: vi.fn(() => true),
    onProgress: event => { events.push(event); }, ...changes,
  };
  const timing = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  return { options, events, timing, now: () => now, advance: (ms: number) => { now += ms; },
    wait: () => waitForFixture(options, timing) };
}

describe("Windows native validation fixture waits", () => {
  it("allows a fixture that becomes ready after 12 seconds within the original lease", async () => {
    const h = harness(), ready = fixture();
    h.options.read = vi.fn(async () => h.now() >= NOW + 12000 ? ready : undefined);
    await expect(h.wait()).resolves.toBe(ready);
    expect(h.now()).toBe(NOW + 12000);
    expect(h.events.at(-1)).toMatchObject({ fixtureStage: "fixture-ready", outcome: "passed", elapsedMs: 12000 });
    expect(h.options.expiresAt).toBe(NOW + 120000);
    expect(h.options.hardExpiresAt).toBe(NOW + 150000);
  });

  it("does not grant a new startup allowance when the original lease has only five seconds left", async () => {
    const h = harness({ expiresAt: NOW + 5000 });
    h.options.read = vi.fn(async () => h.now() >= NOW + 12000 ? fixture() : undefined);
    await expect(h.wait()).rejects.toMatchObject({ stage: "fixture-ready", deadline: NOW + 5000 });
    expect(h.now()).toBe(NOW + 5000);
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", failure: "timeout", elapsedMs: 5000 });
    expect(h.options.expiresAt).toBe(NOW + 5000);
  });

  it("also respects the original hard deadline when it is earlier", async () => {
    const h = harness({ hardExpiresAt: NOW + 3000 });
    await expect(h.wait()).rejects.toMatchObject({ deadline: NOW + 3000 });
    expect(h.now()).toBe(NOW + 3000);
  });

  it("fails within the startup budget when the hidden fixture never becomes ready", async () => {
    const h = harness();
    await expect(h.wait()).rejects.toBeInstanceOf(FixtureWaitTimeoutError);
    expect(h.now()).toBe(NOW + 30000);
    expect(h.events.at(-1)).toMatchObject({ fixtureStage: "fixture-ready", outcome: "failed",
      failure: "timeout", observation: { exists: false } });
    expect(h.events.some(event => event.outcome === "passed")).toBe(false);
  });

  it.each([
    { change: { nonce: "foreign-validation" }, observation: { nonceMatches: false } },
    { change: { session: 3 }, observation: { sessionMatches: false } },
    { change: { closed: true }, observation: { closed: true } },
  ])("rejects an unrelated or closed fixture: $change", async ({ change, observation }) => {
    const h = harness({ read: vi.fn(async () => fixture(change)) });
    await expect(h.wait()).rejects.toBeInstanceOf(FixtureWaitTimeoutError);
    expect(h.options.predicate).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", observation });
  });

  it("aborts on heartbeat failure before reading again and records the phase before caller recovery", async () => {
    const h = harness(), lost = new Error("owner heartbeat failed"), order: string[] = [];
    const reads: number[] = [];
    h.options.assertHeartbeat = () => { if (h.now() >= NOW + 2000) throw lost; };
    h.options.read = async () => { reads.push(h.now()); return undefined; };
    h.options.onProgress = event => {
      h.events.push(event);
      if (event.outcome === "failed") order.push("failed:" + event.fixtureStage);
    };
    const result = await h.wait().catch(error => { order.push("caller-recovery"); return error; });
    expect(result).toBe(lost);
    expect(h.now()).toBe(NOW + 2000);
    expect(reads.every(at => at < NOW + 2000)).toBe(true);
    expect(order).toEqual(["failed:fixture-ready", "caller-recovery"]);
    expect(h.events.at(-1)).toMatchObject({ failure: "heartbeat" });
  });

  it("rechecks heartbeat after a read instead of accepting a result from a lost owner", async () => {
    const h = harness(), lost = new Error("owner heartbeat failed during read");
    h.options.assertHeartbeat = () => { if (h.now() >= NOW + 2000) throw lost; };
    h.options.read = async () => { h.advance(2000); return fixture(); };
    await expect(h.wait()).rejects.toBe(lost);
    expect(h.options.predicate).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", failure: "heartbeat" });
  });

  it("rejects a matching result returned by a file read that crossed the original deadline", async () => {
    const h = harness({ expiresAt: NOW + 5000 });
    h.options.read = async () => { h.advance(5001); return fixture(); };
    await expect(h.wait()).rejects.toMatchObject({ stage: "fixture-ready", deadline: NOW + 5000 });
    expect(h.options.predicate).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", failure: "timeout",
      observation: { exists: true, nonceMatches: true, sessionMatches: true, closed: false } });
    expect(h.events.some(event => event.outcome === "passed")).toBe(false);
  });

  it("rechecks the deadline after evaluating the expected fixture state", async () => {
    const h = harness({ expiresAt: NOW + 5000, read: async () => fixture() });
    h.options.predicate = () => { h.advance(5000); return true; };
    await expect(h.wait()).rejects.toBeInstanceOf(FixtureWaitTimeoutError);
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", failure: "timeout" });
    expect(h.events.some(event => event.outcome === "passed")).toBe(false);
  });

  it("does not return success when writing the matched-state diagnostic crosses the deadline", async () => {
    const h = harness({ expiresAt: NOW + 5000, read: async () => fixture() });
    h.options.onProgress = async event => {
      h.events.push(event);
      if (event.outcome === "passed") h.advance(5000);
    };
    await expect(h.wait()).rejects.toBeInstanceOf(FixtureWaitTimeoutError);
    expect(h.events.at(-1)).toMatchObject({ outcome: "failed", failure: "timeout", elapsedMs: 5000 });
  });

  it.each([
    { stage: "unicode-input" as const, predicate: (f: FixtureWaitState) => f.text === EXPECTED_TEXT },
    { stage: "click-input" as const, predicate: (f: FixtureWaitState) => f.clicks === 1 },
    { stage: "pointer-isolation" as const, predicate: (f: FixtureWaitState) => f.warps >= 1 },
  ])("keeps the eight-second input limit and identifies $stage", async ({ stage, predicate }) => {
    const h = harness({ stage, predicate, read: async () => fixture() });
    await expect(h.wait()).rejects.toMatchObject({ stage, deadline: NOW + 8000 });
    expect(h.now()).toBe(NOW + 8000);
    expect(h.events.at(-1)).toMatchObject({ fixtureStage: stage, outcome: "failed", failure: "timeout" });
  });

  it("uses an independent read-only eight-second recovery wait after the owner lease expired", async () => {
    const h = harness(), ready = fixture();
    h.advance(200000);
    const started = h.now();
    const options: FixtureWaitOptions<FixtureWaitState> = { stage: "recovery-fixture", nonce: NONCE, session: 2,
      expectedText: EXPECTED_TEXT, predicate: () => true,
      read: async () => h.now() >= started + 1000 ? ready : undefined,
      onProgress: event => { h.events.push(event); } };
    await expect(waitForFixture(options, h.timing)).resolves.toBe(ready);
    expect(h.events.at(-1)).toMatchObject({ fixtureStage: "recovery-fixture", outcome: "passed", deadline: started + 8000 });
    expect(h.options.assertHeartbeat).not.toHaveBeenCalled();
    options.read = async () => undefined;
    const secondStart = h.now();
    await expect(waitForFixture(options, h.timing)).rejects.toMatchObject({ stage: "recovery-fixture", deadline: secondStart + 8000 });
    expect(h.now()).toBe(secondStart + 8000);
  });

  it("logs only comparison summaries, including when a read error contains sensitive content", async () => {
    const h = harness({ expiresAt: NOW + 1000 });
    const privateText = "private application content", privateToken = "private lease token";
    h.options.read = async () => ({ ...fixture({ text: privateText }), leaseToken: privateToken });
    h.options.predicate = () => false;
    await expect(h.wait()).rejects.toBeInstanceOf(FixtureWaitTimeoutError);
    const log = JSON.stringify(h.events);
    expect(log).not.toContain(privateText);
    expect(log).not.toContain(privateToken);
    expect(log).not.toContain(NONCE);
    expect(h.events.at(-1)).toMatchObject({ observation: { textMatchesExpected: false } });

    const readError = new SyntaxError(privateText), next = harness();
    next.options.read = async () => { throw readError; };
    await expect(next.wait()).rejects.toBe(readError);
    expect(next.events.at(-1)).toMatchObject({ fixtureStage: "fixture-ready", outcome: "failed", failure: "read" });
    expect(JSON.stringify(next.events)).not.toContain(privateText);
  });
});
