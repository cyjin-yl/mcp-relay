type Task<T> = {
  id: string;
  readOnly: boolean;
  deadline: number;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
  controller: AbortController;
  phase: "queued" | "running" | "done";
  settled: boolean;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CallTimeoutError extends Error {
  readonly code = "tool_timeout";
  constructor(timeoutMs: number, phase: string) {
    super(`tool timed out after ${timeoutMs}ms (${phase})`);
  }
}

export class CallCancelledError extends Error {
  readonly code = "tool_cancelled";
  constructor() { super("tool call cancelled"); }
}

/** Mutations (including the persistent kernel) retain one ordered lane.
 * Read-only calls use a separate bounded lane, so a shell cannot starve reads.
 * A deadline includes queue time. Cancellation never releases a running slot
 * until the executor has actually stopped, even if it ignores AbortSignal.
 */
export class CallScheduler<T> {
  private tasks = new Map<string, Task<T>>();
  private readers: Task<T>[] = [];
  private writers: Task<T>[] = [];
  private activeReaders = 0;
  private activeWriter = false;
  private closed = false;
  private readonly idleListeners = new Set<() => void>();
  private readonly maxReaders: number;
  private readonly maxPending: number;

  constructor(maxReaders = 4, maxPending = 32) {
    this.maxReaders = maxReaders;
    this.maxPending = maxPending;
  }

  /** Includes cancelled operations until their executor actually stops. */
  get pendingCount(): number { return this.tasks.size; }

  onIdle(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => { this.idleListeners.delete(listener); };
  }

  waitForIdle(): Promise<void> {
    if (this.tasks.size === 0) return Promise.resolve();
    return new Promise<void>((resolveIdle) => {
      const unsubscribe = this.onIdle(() => { unsubscribe(); resolveIdle(); });
    });
  }

  private notifyIdle(): void {
    if (this.tasks.size === 0) for (const listener of this.idleListeners) listener();
  }

  schedule(id: string, readOnly: boolean, timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new CallCancelledError());
    if (this.tasks.has(id)) return Promise.reject(new Error("duplicate tool call id"));
    if (this.tasks.size >= this.maxPending) return Promise.reject(new Error("device is busy; retry shortly"));
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const task: Task<T> = {
      id, readOnly, timeoutMs, deadline: performance.now() + timeoutMs, run,
      controller: new AbortController(), phase: "queued", settled: false, resolve, reject,
      timer: setTimeout(() => this.expire(task), timeoutMs)
    };
    this.tasks.set(id, task);
    (readOnly ? this.readers : this.writers).push(task);
    this.drain();
    return promise;
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (task) this.abort(task, new CallCancelledError());
  }

  close(): void {
    this.closed = true;
    for (const task of [...this.tasks.values()]) this.abort(task, new CallCancelledError());
  }

  private expire(task: Task<T>): void {
    this.abort(task, new CallTimeoutError(task.timeoutMs, task.phase));
  }

  private abort(task: Task<T>, reason: Error): void {
    if (task.phase === "done") return;
    task.controller.abort(reason);
    if (!task.settled) {
      task.settled = true;
      task.reject(reason);
    }
    clearTimeout(task.timer);
    if (task.phase === "queued") {
      task.phase = "done";
      this.tasks.delete(task.id);
      this.readers = this.readers.filter((entry) => entry !== task);
      this.writers = this.writers.filter((entry) => entry !== task);
      this.drain();
      this.notifyIdle();
    }
  }

  private drain(): void {
    if (this.closed) return;
    while (this.activeReaders < this.maxReaders && this.readers.length > 0) {
      const task = this.readers.shift()!;
      if (task.phase === "queued") this.start(task);
    }
    while (!this.activeWriter && this.writers.length > 0) {
      const task = this.writers.shift()!;
      if (task.phase === "queued") this.start(task);
    }
  }

  private start(task: Task<T>): void {
    // Timers may not have fired yet after synchronous work blocked the loop.
    if (performance.now() >= task.deadline) {
      this.expire(task);
      return;
    }
    task.phase = "running";
    if (task.readOnly) this.activeReaders++;
    else this.activeWriter = true;
    void (async () => {
      try {
        task.controller.signal.throwIfAborted();
        const result = await task.run(task.controller.signal);
        if (!task.settled && performance.now() >= task.deadline) this.expire(task);
        if (!task.settled) {
          task.settled = true;
          task.resolve(result);
        }
      } catch (error) {
        if (!task.settled) {
          task.settled = true;
          task.reject(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        clearTimeout(task.timer);
        task.phase = "done";
        this.tasks.delete(task.id);
        if (task.readOnly) this.activeReaders--;
        else this.activeWriter = false;
        this.drain();
        this.notifyIdle();
      }
    })();
  }
}
