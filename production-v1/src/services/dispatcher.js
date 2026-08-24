import { randomUUID } from 'node:crypto';

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('dispatcher clock returned an invalid instant');
  return date;
}

export function createDispatcher({
  store,
  processTurn,
  workerId = `worker-${randomUUID()}`,
  now = () => new Date(),
  pollIntervalMs = 250,
  leaseDurationMs = 15_000,
  renewalIntervalMs = 5_000,
} = {}) {
  if (!store || typeof processTurn !== 'function') throw new Error('dispatcher dependencies are required');
  if (renewalIntervalMs >= leaseDurationMs) throw new Error('renewal interval must be shorter than lease duration');
  let started = false;
  let stopped = false;
  let timer = null;
  let loopPromise = null;

  async function runOnce() {
    const claimedAt = asDate(now());
    const leaseToken = randomUUID();
    const turn = await store.claimNextTurn({
      workerId,
      leaseToken,
      now: claimedAt,
      leaseUntil: new Date(claimedAt.getTime() + leaseDurationMs),
    });
    if (!turn) return false;

    const controller = new AbortController();
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      const renewedAt = asDate(now());
      void store.renewTurnLease({
        turnId: turn.id,
        leaseToken,
        now: renewedAt,
        leaseUntil: new Date(renewedAt.getTime() + leaseDurationMs),
      }).catch(() => controller.abort()).finally(() => { renewing = false; });
    }, renewalIntervalMs);
    renewal.unref?.();
    try {
      await processTurn({ turn, leaseToken, signal: controller.signal, workerId });
    } finally {
      clearInterval(renewal);
      controller.abort();
    }
    return true;
  }

  function schedule(delay = pollIntervalMs) {
    if (!started || stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void loop();
    }, delay);
    timer.unref?.();
  }

  async function loop() {
    if (loopPromise) return loopPromise;
    loopPromise = (async () => {
      try {
        let claimed;
        do {
          claimed = await runOnce();
        } while (claimed && started && !stopped);
      } catch {
        // Durable polling retries on the next interval; request/provider data is never logged here.
      } finally {
        loopPromise = null;
        schedule();
      }
    })();
    return loopPromise;
  }

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    schedule(0);
  }

  function wake() {
    if (!started || stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(0);
  }

  async function stop() {
    stopped = true;
    started = false;
    if (timer) clearTimeout(timer);
    timer = null;
    await loopPromise;
  }

  return { workerId, runOnce, start, wake, stop };
}
