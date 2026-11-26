import { setTimeout as delay } from "node:timers/promises";

export interface FixtureWaitState {
  nonce: string; session: number; closed: boolean; text: string; clicks: number; warps: number;
}
export type FixtureWaitStage = "fixture-ready" | "unicode-input" | "click-input" | "pointer-isolation" | "recovery-fixture";
export type OwnerFixtureWaitStage = Exclude<FixtureWaitStage, "recovery-fixture">;
type Failure = "heartbeat" | "timeout" | "read" | "predicate" | "progress" | "delay";
interface Observation {
  exists: boolean; nonceMatches: boolean; sessionMatches: boolean; closed: boolean | null;
  textMatchesExpected: boolean; clicks: number | null; warps: number | null;
}
export interface FixtureWaitProgress {
  fixtureStage: FixtureWaitStage; outcome: "started" | "passed" | "failed";
  deadline: number; elapsedMs: number; observation: Observation; failure?: Failure;
}
export type FixtureWaitOptions<T extends FixtureWaitState> = {
  nonce: string; session: number; expectedText: string;
  read: () => Promise<T | undefined>;
  predicate: (fixture: T) => boolean;
  onProgress?: (event: FixtureWaitProgress) => void | Promise<void>;
} & ({
  stage: OwnerFixtureWaitStage; expiresAt: number; hardExpiresAt: number; assertHeartbeat: () => void;
} | {
  // Recovery observes the preserved application after ownership has ended. It
  // must not renew or reuse the expired owner's authorization to do that read.
  stage: "recovery-fixture"; expiresAt?: never; hardExpiresAt?: never; assertHeartbeat?: never;
});

export class FixtureWaitTimeoutError extends Error {
  constructor(readonly stage: FixtureWaitStage, readonly deadline: number) {
    super("The owned child-session fixture did not reach the expected state.");
    this.name = "FixtureWaitTimeoutError";
  }
}

export async function waitForFixture<T extends FixtureWaitState>(options: FixtureWaitOptions<T>, timing: {
  now: () => number; sleep: (milliseconds: number) => Promise<void>;
} = { now: Date.now, sleep: delay }): Promise<T> {
  const startedAt = timing.now(), budget = options.stage === "fixture-ready" ? 30000 : 8000;
  const deadline = options.stage === "recovery-fixture" ? startedAt + budget
    : Math.min(startedAt + budget, options.expiresAt, options.hardExpiresAt);
  if (!Number.isFinite(deadline)) throw new Error("Invalid fixture validation deadline.");
  const summarize = (fixture: T | undefined): Observation => ({
    exists: fixture !== undefined,
    nonceMatches: fixture?.nonce === options.nonce,
    sessionMatches: fixture?.session === options.session,
    closed: typeof fixture?.closed === "boolean" ? fixture.closed : null,
    textMatchesExpected: fixture?.text === options.expectedText,
    clicks: typeof fixture?.clicks === "number" && Number.isFinite(fixture.clicks) ? fixture.clicks : null,
    warps: typeof fixture?.warps === "number" && Number.isFinite(fixture.warps) ? fixture.warps : null,
  });
  let observation = summarize(undefined), failure: Failure = "progress";
  const report = async (outcome: FixtureWaitProgress["outcome"]) => {
    await options.onProgress?.({ fixtureStage: options.stage, outcome, deadline,
      elapsedMs: Math.max(0, timing.now() - startedAt), observation, ...(outcome === "failed" ? { failure } : {}) });
  };
  const check = () => {
    failure = "heartbeat";
    if (options.stage !== "recovery-fixture") options.assertHeartbeat();
    failure = "timeout";
    if (timing.now() >= deadline) throw new FixtureWaitTimeoutError(options.stage, deadline);
  };
  try {
    await report("started");
    for (;;) {
      check();
      failure = "read";
      const fixture = await options.read();
      observation = summarize(fixture);
      // A slow file read must not turn a late result into an authorized success.
      check();
      failure = "predicate";
      const matched = fixture?.nonce === options.nonce && fixture.session === options.session
        && fixture.closed === false && options.predicate(fixture);
      check();
      if (matched) {
        failure = "progress";
        await report("passed");
        // Even diagnostic I/O may be slow. A recorded match is not permission
        // to return success after the original authorization has expired.
        check();
        return fixture!;
      }
      failure = "delay";
      await timing.sleep(Math.max(0, Math.min(100, deadline - timing.now())));
    }
  } catch (error) {
    // Record the actual failed stage before the caller begins recovery. Logging
    // failure must not prevent recovery or replace the original heartbeat error.
    await report("failed").catch(() => {});
    throw error;
  }
}
