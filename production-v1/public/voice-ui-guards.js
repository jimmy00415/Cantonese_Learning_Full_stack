export function acceptedVoiceComposerDraft({ phase, bindingText, composerDraft = '' } = {}) {
  const draft = String(composerDraft ?? '');
  const shouldApply = phase === 'accepted-cleanup-pending'
    && typeof bindingText === 'string'
    && bindingText.length > 0
    && draft === bindingText;
  return Object.freeze({ shouldApply, draft: shouldApply ? '' : draft });
}

const CANCELABLE_INTERACTION_PHASES = new Set(['permission-checking', 'recording', 'starting']);

export function voicePhaseCanCancelInteraction(phase) {
  return CANCELABLE_INTERACTION_PHASES.has(phase);
}

export function createVoiceHoldFence() {
  let active = null;
  return Object.freeze({
    begin() {
      active = Object.freeze({});
      return active;
    },
    isCurrent(token) { return Boolean(token && token === active); },
    clear(token) {
      if (!token || token !== active) return false;
      active = null;
      return true;
    },
    invalidate() { active = null; },
  });
}

export function createVoiceActivationGate({ now = () => Date.now(), dedupeMs = 750 } = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isFinite(dedupeMs) || dedupeMs < 0) throw new TypeError('dedupeMs must be non-negative');
  let lastDirectActivation = Number.NEGATIVE_INFINITY;
  return Object.freeze({
    markDirectActivation() {
      const clock = Number(now());
      if (Number.isFinite(clock)) lastDirectActivation = clock;
    },
    shouldHandleClick() {
      const clock = Number(now());
      return Number.isFinite(clock) && clock - lastDirectActivation >= dedupeMs;
    },
  });
}

export async function guardedVoicePreflight({ runtime, isCurrent } = {}) {
  if (!runtime?.controller || typeof isCurrent !== 'function') return { state: 'stale' };
  const result = await runtime.controller.preflightPermission();
  if (!isCurrent() || result?.state === 'stale') return { state: 'stale' };
  const snapshot = runtime.controller.snapshot();
  return snapshot?.permission === 'ready' ? { state: 'ready' } : { state: 'stale' };
}

export async function guardedVoiceRemove({ runtime, isCurrent, preservedText = '', bindingText = null } = {}) {
  if (!runtime?.controller || typeof isCurrent !== 'function') return { apply: false, result: { state: 'stale' } };
  const result = await runtime.controller.remove();
  if (!isCurrent() || result?.state === 'stale') return { apply: false, result };
  const draft = String(preservedText);
  const exactAcceptedText = result?.state === 'consumed'
    && typeof bindingText === 'string'
    && bindingText.length > 0
    && draft === bindingText;
  return {
    apply: true,
    draft: exactAcceptedText ? '' : draft,
    result,
  };
}

export async function clearVoiceScopeAfterProvenDeletion({ scope, runtime, createStore } = {}) {
  if (typeof scope !== 'string' || !scope) return { cleared: true, count: 0 };
  if (runtime?.scope === scope && typeof runtime.store?.clearScope === 'function') {
    return { cleared: true, count: await runtime.store.clearScope(scope) };
  }
  if (typeof createStore !== 'function') throw new TypeError('createStore is required');
  const store = createStore();
  try {
    const active = await store.readActiveScope();
    if (active && active.clientSessionScope !== scope) return { cleared: true, count: 0 };
    await store.bindScope(scope, { expectedActiveScope: active });
    return { cleared: true, count: await store.clearScope(scope) };
  } finally {
    await store.dispose();
  }
}
