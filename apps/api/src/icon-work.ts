interface Work {
  key: string;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  run: (signal: AbortSignal) => Promise<unknown>;
  waiters: number;
  queued: boolean;
  finished: boolean;
  timer: NodeJS.Timeout;
  timeoutValue: unknown;
}

/** Shared by origin discovery and pinned library resources; keys include their source. */
export class IconWorkQueue {
  private readonly tasks = new Map<string, Work>();
  private readonly queue: Work[] = [];
  private readonly capacityWaiters = new Set<() => void>();
  private active = 0;

  waitForSlot() {
    return this.active < 4 ? Promise.resolve() : new Promise<void>(resolve => this.capacityWaiters.add(resolve));
  }

  async join<T>(key: string, run: (signal: AbortSignal) => Promise<T | null>, signal?: AbortSignal, budgetMs = 10_000, timeoutValue: T | null = null): Promise<T | null> {
    if (signal?.aborted) return null;
    let job = this.tasks.get(key);
    if (!job) {
      if (this.active >= 4 && this.queue.filter(item => !item.finished).length >= 64) return null;
      let resolve!: (value: unknown) => void;
      const promise = new Promise<unknown>(done => { resolve = done; });
      const controller = new AbortController();
      job = { key, controller, promise, resolve, run, waiters: 0, queued: false, finished: false, timer: undefined as unknown as NodeJS.Timeout, timeoutValue };
      const current = job;
      job.timer = setTimeout(() => {
        controller.abort('budget');
        if (current.queued) this.finish(current, null);
      }, budgetMs);
      this.tasks.set(key, job);
      if (this.active < 4) this.launch(job);
      else { job.queued = true; this.queue.push(job); }
    }
    job.waiters++;
    try {
      if (!signal) return await job.promise as T | null;
      return await new Promise<T | null>(resolve => {
        const done = (value: unknown) => { signal.removeEventListener('abort', onAbort); resolve(value as T | null); };
        const onAbort = () => done(null);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        job!.promise.then(done);
      });
    } finally {
      job.waiters--;
      if (!job.waiters && !job.finished) {
        job.controller.abort('no-waiters');
        if (job.queued) this.finish(job, null);
      }
    }
  }

  private launch(job: Work) {
    if (job.finished || job.controller.signal.aborted) { this.finish(job, null); return; }
    job.queued = false;
    this.active++;
    const aborted = new Promise<unknown>(resolve => job.controller.signal.addEventListener('abort', () => resolve(job.controller.signal.reason === 'budget' ? job.timeoutValue : null), { once: true }));
    void Promise.race([job.run(job.controller.signal).catch(() => null), aborted]).then(value => this.finish(job, value));
  }

  private finish(job: Work, value: unknown) {
    if (job.finished) return;
    job.finished = true;
    clearTimeout(job.timer);
    this.tasks.delete(job.key);
    if (!job.queued) this.active--;
    job.resolve(value);
    while (this.active < 4 && this.queue.length) {
      const next = this.queue.shift()!;
      if (!next.finished) this.launch(next);
    }
    if (this.active < 4) {
      for (const resolve of this.capacityWaiters) resolve();
      this.capacityWaiters.clear();
    }
  }
}
