import { randomUUID } from 'node:crypto';

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('dispatcher clock returned an invalid instant');
  return date;
}

export const dispatcherLimits = Object.freeze({ concurrency: 4 });

export function createDispatcher({
  store,
  processTurn,
  workerId = `worker-${randomUUID()}`,
  now = () => new Date(),
  pollIntervalMs = 250,
  leaseDurationMs = 15_000,
  renewalIntervalMs = 5_000,
  concurrency = dispatcherLimits.concurrency,
} = {}) {
  if (!store || typeof processTurn !== 'function') throw new Error('dispatcher dependencies are required');
  if (renewalIntervalMs >= leaseDurationMs) throw new Error('renewal interval must be shorter than lease duration');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('dispatcher concurrency must be between 1 and 16');
  let started = false;
  let stopped = false;
  let timer = null;
  let pumpPromise = null;
  let stopPromise = null;
  const activeJobs = new Set();
  const activeControllers = new Set();
  const activeRenewals = new Set();

  async function executeClaim(turn, leaseToken, controller) {
    let renewalPromise = null;
    const renewal = setInterval(() => {
      if (renewalPromise || controller.signal.aborted) return;
      const renewedAt = asDate(now());
      const tracked = store.renewTurnLease({
        turnId: turn.id,
        leaseToken,
        now: renewedAt,
        leaseUntil: new Date(renewedAt.getTime() + leaseDurationMs),
      }).catch(() => controller.abort());
      renewalPromise = tracked;
      activeRenewals.add(tracked);
      void tracked.finally(() => {
        activeRenewals.delete(tracked);
        if (renewalPromise === tracked) renewalPromise = null;
      });
    }, renewalIntervalMs);
    renewal.unref?.();
    try {
      await processTurn({ turn, leaseToken, signal: controller.signal, workerId });
    } finally {
      clearInterval(renewal);
      controller.abort();
      await renewalPromise?.catch(() => undefined);
      activeControllers.delete(controller);
    }
  }

  function launch(turn, leaseToken) {
    const controller = new AbortController();
    activeControllers.add(controller);
    if (stopped) controller.abort();
    const job = executeClaim(turn, leaseToken, controller).catch(() => undefined);
    activeJobs.add(job);
    void job.finally(() => {
      activeJobs.delete(job);
      if (started && !stopped) schedule(0);
    });
    return job;
  }

  async function claimAndLaunch() {
    if (stopped) return null;
    const claimedAt = asDate(now());
    const leaseToken = randomUUID();
    const turn = await store.claimNextTurn({
      workerId,
      leaseToken,
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + leaseDurationMs),
    });
    if (!turn) return null;
    return { job: launch(turn, leaseToken) };
  }

  async function runOnce() {
    const claimed = await claimAndLaunch();
    if (!claimed) return false;
    await claimed.job;
    return true;
  }

  function schedule(delay = pollIntervalMs) {
    if (!started || stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, delay);
    timer.unref?.();
  }

  async function pump() {
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      try {
        while (started && !stopped && activeJobs.size < concurrency) {
          const claimed = await claimAndLaunch();
          if (!claimed) break;
        }
      } catch {
        // Durable polling retries on the next interval; request/provider data is never logged here.
      } finally {
        pumpPromise = null;
        if (started && !stopped && activeJobs.size < concurrency) schedule();
      }
    })();
    return pumpPromise;
  }

  function start() {
    if (started || stopped) return;
    started = true;
    schedule(0);
  }

  function wake() {
    if (!started || stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(0);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const controller of activeControllers) controller.abort();
    stopPromise = (async () => {
      await pumpPromise?.catch(() => undefined);
      for (const controller of activeControllers) controller.abort();
      while (activeJobs.size > 0 || activeRenewals.size > 0) {
        await Promise.allSettled([...activeJobs, ...activeRenewals]);
      }
    })();
    return stopPromise;
  }

  return { workerId, runOnce, start, wake, stop };
}
