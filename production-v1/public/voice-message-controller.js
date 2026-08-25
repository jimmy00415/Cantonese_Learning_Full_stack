const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIFECYCLE_CANCEL_REASONS = new Set([
  'cancel',
  'escape',
  'hidden',
  'lostpointercapture',
  'pagehide',
  'pointercancel',
  'visible-cancel',
]);
const TERMINAL_LIFECYCLE_REASONS = new Set(['hidden', 'pagehide']);
const REPLY_LANGUAGES = new Set(['en', 'yue-Hant-HK', 'cmn-Hans-CN']);
const REPLY_MODES = new Set(['text', 'voice']);

const SAFE_ERRORS = Object.freeze({
  VOICE_CONSENT_REQUIRED: 'Review and allow microphone access before recording.',
  VOICE_CONTROLLER_DISPOSED: 'Voice input is no longer active. You can continue by typing.',
  VOICE_CONTROLLER_SUSPENDED: 'Voice input paused when this page became inactive. Reopen it to continue.',
  VOICE_PERMISSION_FAILED: 'Microphone access is blocked. Allow it in your browser or device settings, then retry—or continue by typing.',
  VOICE_CAPTURE_FAILED: 'The recording could not be completed. You can continue by typing.',
  VOICE_RECORDING_INVALID: 'The recording could not be prepared safely. Please try again or type your message.',
  VOICE_RECORDING_SAVE_FAILED: 'The recording could not be saved safely. Please try again or type your message.',
  VOICE_TRANSCRIPTION_RETRYABLE: 'The voice message is saved and can be retried.',
  VOICE_TRANSCRIPTION_FAILED: 'The recording could not be transcribed. You can remove it or continue by typing.',
  VOICE_DRAFT_UNAVAILABLE: 'This voice draft is no longer available. Please record it again or type your message.',
  VOICE_MESSAGE_IDENTITY_INVALID: 'The voice message identity is invalid.',
  VOICE_REPLY_PREFERENCES_INVALID: 'The reply preferences are invalid. Please review them before sending.',
  VOICE_MESSAGE_BIND_FAILED: 'The voice draft could not be prepared for sending. Please reload before retrying.',
  VOICE_MESSAGE_ALREADY_BOUND: 'This voice draft already has a fixed send identity. Use Retry to send it again.',
  VOICE_SEND_NOT_CONFIRMED: 'Sending could not be confirmed. Retry will use the same voice message identity.',
  VOICE_SEND_REJECTED: 'The voice message was not accepted. You can remove it or continue by typing.',
  VOICE_ACCEPTANCE_CLEANUP_FAILED: 'Your message was accepted. Local voice-draft cleanup will retry after refresh.',
  RATE_LIMITED: 'Please wait before retrying this voice message.',
  VOICE_RETRY_UNAVAILABLE: 'This voice message cannot be retried from the current chat state.',
  VOICE_REMOVE_FAILED: 'The voice message could not be removed yet. Please retry when the connection returns.',
  VOICE_REMOVE_BLOCKED: 'This voice message may already be attached. Refresh the chat before removing it.',
  VOICE_SCOPE_RECOVERY_FAILED: 'Saved voice work could not be restored safely. You can continue by typing.',
});

class VoiceMessageControllerError extends Error {
  constructor(code) {
    super(SAFE_ERRORS[code] ?? SAFE_ERRORS.VOICE_CAPTURE_FAILED);
    this.name = 'VoiceMessageControllerError';
    this.code = SAFE_ERRORS[code] ? code : 'VOICE_CAPTURE_FAILED';
    this.textSafe = true;
  }
}

function requireMethod(target, method, owner) {
  if (typeof target?.[method] !== 'function') throw new TypeError(`${owner}.${method} is required`);
}

function requireScope(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('clientSessionScope is required');
  return value;
}

function requireTimestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError('now must return a finite timestamp');
  return number;
}

function normalizeText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 4_000) return null;
  return text;
}

function normalizeReplyPreferences({ replyLanguage = 'en', replyMode = 'text' } = {}) {
  if (!REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)) return null;
  return { replyLanguage, replyMode };
}

function validDraftId(value) {
  return typeof value === 'string' && UUID.test(value);
}

function publicOperation(operation) {
  if (!operation || typeof operation !== 'object') return null;
  return {
    clientUploadId: operation.clientUploadId,
    state: operation.state,
    createdAt: operation.createdAt ?? null,
    expiresAt: operation.expiresAt ?? null,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeError(code) {
  const safeCode = SAFE_ERRORS[code] ? code : 'VOICE_CAPTURE_FAILED';
  return deepFreeze({ code: safeCode, copy: SAFE_ERRORS[safeCode], textSafe: true });
}

function observeMaybePromise(value) {
  if (value && typeof value.then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    return true;
  }
  return false;
}

function latestOperation(operations) {
  const active = (Array.isArray(operations) ? operations : [])
    .filter((operation) => operation && operation.state !== 'terminal');
  if (active.length === 0) return null;
  return [...active].sort((left, right) => {
    const bindingPriority = Number(Boolean(left.messageBinding)) - Number(Boolean(right.messageBinding));
    if (bindingPriority !== 0) return bindingPriority;
    return Number(left.createdAt ?? 0) - Number(right.createdAt ?? 0)
      || String(left.clientUploadId ?? '').localeCompare(String(right.clientUploadId ?? ''));
  }).at(-1);
}

function canonicalAcceptance(messages, binding, voiceDraftId) {
  if (!binding || !voiceDraftId || !Array.isArray(messages)) return false;
  return messages.some((message) => (
    Number.isSafeInteger(message?.sequence)
      && message.sequence > 0
      && message.role === 'user'
      && message.clientMessageId === binding.clientMessageId
      && message.voiceDraftId === voiceDraftId
      && message.replyLanguage === binding.replyLanguage
      && message.replyMode === binding.replyMode
  ));
}

export function createVoiceMessageController({
  capture,
  store,
  coordinator,
  chat,
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  for (const method of ['preflightPermission', 'begin', 'finish', 'cancel', 'dispose']) {
    requireMethod(capture, method, 'capture');
  }
  for (const method of [
    'readActiveScope',
    'bindScope',
    'commitRecording',
    'listByScope',
    'get',
    'bindMessage',
    'releaseMessageBinding',
    'consume',
  ]) {
    requireMethod(store, method, 'store');
  }
  for (const method of ['runById', 'retry', 'cancel', 'dispose']) requireMethod(coordinator, method, 'coordinator');
  for (const method of ['sendMessage', 'retryUnconfirmed', 'snapshot']) requireMethod(chat, method, 'chat');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');

  const state = {
    phase: 'idle',
    consent: 'required',
    permission: 'unknown',
    clientSessionScope: null,
    operation: null,
    draft: null,
    binding: null,
    error: null,
    disposed: false,
  };
  let epoch = 0;
  let activeHold = null;
  let coordinatorStopped = false;

  function currentEpoch(value) {
    return !state.disposed && value === epoch;
  }

  function timestamp() {
    return requireTimestamp(now());
  }

  function snapshot() {
    return deepFreeze({
      phase: state.phase,
      consent: state.consent,
      permission: state.permission,
      clientSessionScope: state.clientSessionScope,
      operation: state.operation ? { ...state.operation } : null,
      draft: state.draft ? { ...state.draft } : null,
      binding: state.binding ? { ...state.binding } : null,
      error: state.error ? { ...state.error } : null,
      disposed: state.disposed,
    });
  }

  function notify() {
    onChange(snapshot());
  }

  function setFailure(code, { phase = 'error' } = {}) {
    state.error = safeError(code);
    state.phase = phase;
    notify();
    return new VoiceMessageControllerError(code);
  }

  function assertUsable() {
    if (state.disposed) throw new VoiceMessageControllerError('VOICE_CONTROLLER_DISPOSED');
    if (coordinatorStopped) throw new VoiceMessageControllerError('VOICE_CONTROLLER_SUSPENDED');
  }

  function resetVisibleVoice() {
    state.operation = null;
    state.draft = null;
    state.binding = null;
    state.error = null;
  }

  function restingPhase() {
    if (state.draft) return state.binding ? 'send-unconfirmed' : 'draft-ready';
    return state.permission === 'ready' ? 'ready' : 'idle';
  }

  function adoptReadyDraft({ clientUploadId, transcript, voiceDraftId, createdAt = null, expiresAt = null, messageBinding = null }) {
    const transcriptText = normalizeText(transcript);
    let binding = null;
    if (messageBinding !== null) {
      const boundText = normalizeText(messageBinding?.text);
      const preferences = normalizeReplyPreferences(messageBinding);
      if (!UUID.test(String(messageBinding?.clientMessageId ?? '')) || !boundText || !preferences) return false;
      binding = { clientMessageId: messageBinding.clientMessageId, text: boundText, ...preferences };
    }
    const visibleText = binding?.text ?? transcriptText;
    if (!UUID.test(String(clientUploadId ?? '')) || !visibleText || !validDraftId(voiceDraftId)) return false;
    state.operation = publicOperation({ clientUploadId, state: 'ready', createdAt, expiresAt });
    state.draft = { text: visibleText, voiceDraftId };
    state.binding = binding;
    state.error = null;
    state.phase = state.binding ? 'send-unconfirmed' : 'draft-ready';
    notify();
    return true;
  }

  async function applyCoordinatorResult(result, operation, runEpoch) {
    if (!currentEpoch(runEpoch)) return { state: 'stale' };
    if (result?.state === 'ready') {
      if (result.clientUploadId !== undefined && result.clientUploadId !== operation.clientUploadId) {
        throw setFailure('VOICE_TRANSCRIPTION_FAILED');
      }
      if (!adoptReadyDraft({
        clientUploadId: result.clientUploadId ?? operation.clientUploadId,
        transcript: result.transcript,
        voiceDraftId: result.voiceDraftId,
        createdAt: operation.createdAt,
        expiresAt: operation.expiresAt,
      })) {
        throw setFailure('VOICE_TRANSCRIPTION_FAILED');
      }
      return result;
    }
    if (result?.state === 'retryable') {
      state.error = safeError('VOICE_TRANSCRIPTION_RETRYABLE');
      state.phase = 'transcription-retryable';
      notify();
      return result;
    }
    if (result?.state === 'terminal') {
      if (result.failureCode === 'VOICE_UPLOAD_CANCELLED') {
        resetVisibleVoice();
        state.phase = 'ready';
        notify();
        return result;
      }
      state.error = safeError('VOICE_TRANSCRIPTION_FAILED');
      state.phase = 'error';
      notify();
      return result;
    }
    if (result?.state === 'consumed') {
      resetVisibleVoice();
      state.phase = 'ready';
      notify();
      return result;
    }
    if (result?.state === 'disposed') {
      state.phase = 'suspended';
      notify();
      return result;
    }
    state.phase = 'processing';
    notify();
    return result ?? { state: 'idle' };
  }

  function confirmConsent() {
    assertUsable();
    state.consent = 'granted';
    state.error = null;
    notify();
    return snapshot();
  }

  async function preflightPermission() {
    assertUsable();
    if (state.consent !== 'granted') {
      state.error = safeError('VOICE_CONSENT_REQUIRED');
      notify();
      throw new VoiceMessageControllerError('VOICE_CONSENT_REQUIRED');
    }
    const runEpoch = epoch;
    state.phase = 'permission-checking';
    state.error = null;
    notify();
    try {
      const result = await capture.preflightPermission({ consent: true });
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      if (result?.status !== 'ready' && result?.state !== 'ready' && result?.permission !== 'ready') {
        throw new VoiceMessageControllerError('VOICE_PERMISSION_FAILED');
      }
      state.permission = 'ready';
      state.phase = state.draft ? 'draft-ready' : 'ready';
      state.error = null;
      notify();
      return result;
    } catch {
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      state.permission = 'unknown';
      throw setFailure('VOICE_PERMISSION_FAILED');
    }
  }

  async function processCaptureOutcome(outcome, runEpoch) {
    if (!currentEpoch(runEpoch)) return { state: 'stale' };
    if (outcome?.status === 'cancelled') {
      state.phase = restingPhase();
      notify();
      return outcome;
    }
    if (outcome?.status !== 'ready') throw setFailure('VOICE_CAPTURE_FAILED');
    if (!(outcome.audio instanceof Blob)
      || outcome.audio.type !== 'audio/wav'
      || !Number.isFinite(outcome.durationMs)
      || outcome.durationMs <= 0
      || outcome.durationMs > 55_000) {
      throw setFailure('VOICE_RECORDING_INVALID');
    }

    state.phase = 'saving';
    state.error = null;
    notify();
    let committed;
    try {
      committed = await store.commitRecording({
        audio: outcome.audio,
        durationMs: outcome.durationMs,
        clientSessionScope: state.clientSessionScope,
        asrLanguage: ['en', 'zhHant', 'zhHans'].includes(chat.snapshot()?.replyLanguage)
          ? chat.snapshot().replyLanguage : 'zhHant',
      });
    } catch {
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      throw setFailure('VOICE_RECORDING_SAVE_FAILED');
    }
    if (!currentEpoch(runEpoch)) return { state: 'stale' };
    state.operation = publicOperation(committed);
    state.draft = null;
    state.binding = null;
    state.phase = 'processing';
    notify();

    let result;
    try {
      result = await coordinator.runById({
        clientUploadId: committed.clientUploadId,
        clientSessionScope: state.clientSessionScope,
      });
    } catch {
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      state.error = safeError('VOICE_TRANSCRIPTION_RETRYABLE');
      state.phase = 'transcription-retryable';
      notify();
      return { state: 'retryable' };
    }
    return applyCoordinatorResult(result, committed, runEpoch);
  }

  function beginHold() {
    assertUsable();
    if (!state.clientSessionScope) throw new VoiceMessageControllerError('VOICE_SCOPE_RECOVERY_FAILED');
    if (state.permission !== 'ready') throw new VoiceMessageControllerError('VOICE_PERMISSION_FAILED');
    if (activeHold) throw new VoiceMessageControllerError('VOICE_CAPTURE_FAILED');

    epoch += 1;
    const runEpoch = epoch;
    let handle;
    try {
      handle = capture.begin();
    } catch {
      throw setFailure('VOICE_CAPTURE_FAILED');
    }
    if (!handle || typeof handle !== 'object' || !handle.started || !handle.result) {
      throw setFailure('VOICE_CAPTURE_FAILED');
    }
    state.phase = 'starting';
    state.error = null;
    notify();

    const started = Promise.resolve(handle.started).then((result) => {
      if (currentEpoch(runEpoch) && activeHold?.epoch === runEpoch) {
        state.phase = 'recording';
        notify();
      }
      return result;
    }, () => {
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      throw setFailure('VOICE_CAPTURE_FAILED');
    });
    const completion = Promise.resolve(handle.result).then(
      (result) => processCaptureOutcome(result, runEpoch),
      () => {
        if (!currentEpoch(runEpoch)) return { state: 'stale' };
        throw setFailure('VOICE_CAPTURE_FAILED');
      },
    ).finally(() => {
      if (activeHold?.epoch === runEpoch) activeHold = null;
    });
    activeHold = { epoch: runEpoch, started, completion, finishRequested: false };
    return Object.freeze({ started, completion });
  }

  function finishHold() {
    assertUsable();
    if (!activeHold) return Promise.resolve({ state: 'idle' });
    if (!activeHold.finishRequested) {
      activeHold.finishRequested = true;
      try {
        // This call is intentionally synchronous at the controller boundary so
        // pointerup can request recorder stop before releasing pointer capture.
        observeMaybePromise(capture.finish('release'));
      } catch {
        return Promise.reject(setFailure('VOICE_CAPTURE_FAILED'));
      }
    }
    return activeHold.completion;
  }

  function cancel(reason = 'cancel') {
    if (!LIFECYCLE_CANCEL_REASONS.has(reason)) throw new TypeError('Unsupported voice cancel reason');
    if (state.disposed) return { status: 'cancelled', reason };
    epoch += 1;
    activeHold = null;
    let result;
    try {
      result = capture.cancel(reason);
    } catch {
      result = { status: 'cancelled', reason };
    }
    if (TERMINAL_LIFECYCLE_REASONS.has(reason)) {
      observeMaybePromise(coordinator.dispose());
      coordinatorStopped = true;
      state.phase = 'suspended';
    } else {
      state.phase = restingPhase();
    }
    state.error = null;
    notify();
    if (observeMaybePromise(result)) return { status: 'cancelled', reason };
    return result && typeof result === 'object' ? result : { status: 'cancelled', reason };
  }

  async function reconcileChatSnapshot(chatSnapshot, { expectedEpoch = epoch } = {}) {
    if (!currentEpoch(expectedEpoch) || !state.operation || !state.binding || !state.draft) return false;
    let canonical = chatSnapshot;
    if (canonical === undefined) {
      try { canonical = chat.snapshot(); } catch {
        throw setFailure('VOICE_SEND_NOT_CONFIRMED', { phase: 'send-unconfirmed' });
      }
    }
    if (!canonicalAcceptance(canonical?.messages, state.binding, state.draft.voiceDraftId)) return false;
    let consumed;
    try {
      consumed = await store.consume({
        clientUploadId: state.operation.clientUploadId,
        clientSessionScope: state.clientSessionScope,
      });
    } catch {
      if (!currentEpoch(expectedEpoch)) return false;
      throw setFailure('VOICE_ACCEPTANCE_CLEANUP_FAILED', { phase: 'accepted-cleanup-pending' });
    }
    if (!currentEpoch(expectedEpoch)) return false;
    if (!consumed) return false;
    resetVisibleVoice();
    state.phase = 'ready';
    notify();
    return true;
  }

  async function resume({ clientSessionScope } = {}) {
    if (state.disposed) throw new VoiceMessageControllerError('VOICE_CONTROLLER_DISPOSED');
    const scope = requireScope(clientSessionScope);
    const replacingScope = Boolean(state.clientSessionScope && state.clientSessionScope !== scope);
    epoch += 1;
    const runEpoch = epoch;
    activeHold = null;
    try { observeMaybePromise(capture.cancel('visible-cancel')); } catch { /* epoch remains the authority */ }
    if (replacingScope) {
      observeMaybePromise(coordinator.dispose());
      coordinatorStopped = true;
    }
    state.clientSessionScope = scope;
    resetVisibleVoice();
    state.phase = 'resuming';
    notify();

    try {
      const activeScope = await store.readActiveScope();
      if (!currentEpoch(runEpoch)) return snapshot();
      await store.bindScope(scope, {
        expectedActiveScope: activeScope?.clientSessionScope ?? null,
        nowMs: timestamp(),
      });
      if (!currentEpoch(runEpoch)) return snapshot();
      const operations = await store.listByScope(scope);
      if (!currentEpoch(runEpoch)) return snapshot();
      const restored = latestOperation(operations);
      if (!restored) {
        state.phase = coordinatorStopped ? 'suspended' : 'ready';
        notify();
        return snapshot();
      }
      state.operation = publicOperation(restored);
      if (restored.state === 'ready') {
        if (!adoptReadyDraft(restored)) throw new VoiceMessageControllerError('VOICE_DRAFT_UNAVAILABLE');
        if (restored.messageBinding) await reconcileChatSnapshot(chat.snapshot(), { expectedEpoch: runEpoch });
        return snapshot();
      }
      if (coordinatorStopped) {
        state.phase = 'suspended';
        notify();
        return snapshot();
      }
      state.phase = 'processing';
      notify();
      const result = await coordinator.runById({
        clientUploadId: restored.clientUploadId,
        clientSessionScope: scope,
      });
      await applyCoordinatorResult(result, restored, runEpoch);
      return snapshot();
    } catch (error) {
      if (!currentEpoch(runEpoch)) return snapshot();
      if (error instanceof VoiceMessageControllerError && error.code === 'VOICE_DRAFT_UNAVAILABLE') {
        throw setFailure('VOICE_DRAFT_UNAVAILABLE');
      }
      if (error instanceof VoiceMessageControllerError) throw error;
      throw setFailure('VOICE_SCOPE_RECOVERY_FAILED');
    }
  }

  function setDraft(value) {
    assertUsable();
    if (!state.draft) throw new VoiceMessageControllerError('VOICE_DRAFT_UNAVAILABLE');
    if (state.binding) throw new VoiceMessageControllerError('VOICE_MESSAGE_ALREADY_BOUND');
    const text = typeof value === 'string' ? value.slice(0, 4_000) : '';
    state.draft = { ...state.draft, text };
    state.error = null;
    state.phase = state.binding ? 'send-unconfirmed' : 'draft-ready';
    notify();
    return snapshot();
  }

  function classifySendFailure(error) {
    if (error?.status === 429 || error?.code === 'RATE_LIMITED') return 'RATE_LIMITED';
    if (Number.isSafeInteger(error?.status) && error.status >= 400 && error.status < 500) {
      return 'VOICE_SEND_REJECTED';
    }
    return 'VOICE_SEND_NOT_CONFIRMED';
  }

  async function sendDraft({ clientMessageId, text = state.draft?.text, replyLanguage, replyMode } = {}) {
    assertUsable();
    if (!UUID.test(String(clientMessageId ?? ''))) {
      throw new VoiceMessageControllerError('VOICE_MESSAGE_IDENTITY_INVALID');
    }
    if (!state.operation || !state.draft) throw new VoiceMessageControllerError('VOICE_DRAFT_UNAVAILABLE');
    const normalized = normalizeText(text);
    if (!normalized) throw new VoiceMessageControllerError('VOICE_DRAFT_UNAVAILABLE');
    let currentPreferences = {};
    try { currentPreferences = chat.snapshot?.() ?? {}; } catch { /* explicit values can still be used */ }
    const preferences = normalizeReplyPreferences({
      replyLanguage: replyLanguage ?? currentPreferences.replyLanguage,
      replyMode: replyMode ?? currentPreferences.replyMode,
    });
    if (!preferences) throw new VoiceMessageControllerError('VOICE_REPLY_PREFERENCES_INVALID');
    if (state.binding) throw new VoiceMessageControllerError('VOICE_MESSAGE_ALREADY_BOUND');
    const runEpoch = epoch;
    state.phase = 'binding';
    state.error = null;
    notify();

    let bound;
    try {
      bound = await store.bindMessage({
        clientUploadId: state.operation.clientUploadId,
        clientSessionScope: state.clientSessionScope,
        voiceDraftId: state.draft.voiceDraftId,
        clientMessageId,
        text: normalized,
        ...preferences,
        nowMs: timestamp(),
      });
    } catch {
      if (!currentEpoch(runEpoch)) return false;
      throw setFailure('VOICE_MESSAGE_BIND_FAILED');
    }
    if (!currentEpoch(runEpoch)) return false;
    if (!bound) throw setFailure('VOICE_MESSAGE_BIND_FAILED');
    state.binding = { clientMessageId, text: normalized, ...preferences };
    state.draft = { ...state.draft, text: normalized };
    state.phase = 'sending';
    notify();

    try {
      const sent = await chat.sendMessage({
        clientMessageId,
        voiceDraftId: state.draft.voiceDraftId,
        text: normalized,
        ...preferences,
      });
      if (!currentEpoch(runEpoch)) return false;
      // Chat notifies canonical state before its send promise settles. A DOM
      // adapter may therefore reconcile and consume this operation reentrantly.
      // Once that happened, the later send completion must not recreate an
      // unconfirmed presentation for an operation that no longer exists.
      if (!state.operation && !state.binding && !state.draft) return sent;
      const accepted = await reconcileChatSnapshot(chat.snapshot(), { expectedEpoch: runEpoch });
      if (!accepted && state.binding) {
        state.phase = 'send-unconfirmed';
        state.error = safeError('VOICE_SEND_NOT_CONFIRMED');
        notify();
      }
      return sent;
    } catch (error) {
      if (!currentEpoch(runEpoch)) return false;
      if (error instanceof VoiceMessageControllerError
        && error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED') throw error;
      const code = classifySendFailure(error);
      throw setFailure(code, { phase: code === 'RATE_LIMITED' ? 'send-rate-limited' : code === 'VOICE_SEND_NOT_CONFIRMED' ? 'send-unconfirmed' : 'error' });
    }
  }

  async function retrySend() {
    assertUsable();
    if (state.phase === 'accepted-cleanup-pending') {
      throw new VoiceMessageControllerError('VOICE_ACCEPTANCE_CLEANUP_FAILED');
    }
    if (!state.operation || !state.draft || !state.binding) {
      throw new VoiceMessageControllerError('VOICE_RETRY_UNAVAILABLE');
    }
    const runEpoch = epoch;
    const exactRetry = {
      clientMessageId: state.binding.clientMessageId,
      voiceDraftId: state.draft.voiceDraftId,
      text: state.binding.text,
      replyLanguage: state.binding.replyLanguage,
      replyMode: state.binding.replyMode,
    };
    state.phase = 'sending';
    state.error = null;
    notify();
    try {
      const retried = await chat.retryUnconfirmed(exactRetry.clientMessageId);
      if (!currentEpoch(runEpoch)) return false;
      if (!state.operation && !state.binding && !state.draft) return true;
      if (retried === false) {
        // A reload loses chat-controller's in-memory optimistic row while the
        // durable voice binding survives. Only that strict false result permits
        // recreating the chat attempt, with the exact persisted tuple. Throws,
        // ambiguity, and rate limits never enter this fallback.
        await chat.sendMessage(exactRetry);
        if (!currentEpoch(runEpoch)) return false;
        if (!state.operation && !state.binding && !state.draft) return true;
      } else if (retried !== true) {
        throw new VoiceMessageControllerError('VOICE_RETRY_UNAVAILABLE');
      }
      await reconcileChatSnapshot(chat.snapshot(), { expectedEpoch: runEpoch });
      if (state.binding) {
        state.phase = 'send-unconfirmed';
        state.error = safeError('VOICE_SEND_NOT_CONFIRMED');
        notify();
      }
      return true;
    } catch (error) {
      if (!currentEpoch(runEpoch)) return false;
      if (error instanceof VoiceMessageControllerError
        && error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED') throw error;
      if (error instanceof VoiceMessageControllerError && error.code === 'VOICE_RETRY_UNAVAILABLE') {
        throw setFailure('VOICE_RETRY_UNAVAILABLE', { phase: 'send-unconfirmed' });
      }
      const code = classifySendFailure(error);
      throw setFailure(code, { phase: code === 'RATE_LIMITED' ? 'send-rate-limited' : 'send-unconfirmed' });
    }
  }

  async function retryTranscription() {
    assertUsable();
    if (state.phase !== 'transcription-retryable' || !state.operation) {
      throw new VoiceMessageControllerError('VOICE_TRANSCRIPTION_RETRYABLE');
    }
    const runEpoch = epoch;
    const exactOperation = {
      clientUploadId: state.operation.clientUploadId,
      clientSessionScope: state.clientSessionScope,
    };
    state.phase = 'processing';
    state.error = null;
    notify();
    let result;
    try {
      result = await coordinator.retry(exactOperation);
    } catch {
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      state.phase = 'transcription-retryable';
      state.error = safeError('VOICE_TRANSCRIPTION_RETRYABLE');
      notify();
      throw new VoiceMessageControllerError('VOICE_TRANSCRIPTION_RETRYABLE');
    }
    return applyCoordinatorResult(result, state.operation, runEpoch);
  }

  async function retryAcceptedCleanup() {
    assertUsable();
    if (state.phase !== 'accepted-cleanup-pending'
      || !state.operation
      || !state.draft
      || !state.binding) {
      throw new VoiceMessageControllerError('VOICE_ACCEPTANCE_CLEANUP_FAILED');
    }
    const runEpoch = epoch;
    const exactOperation = {
      clientUploadId: state.operation.clientUploadId,
      clientSessionScope: state.clientSessionScope,
    };
    let consumed;
    try {
      consumed = await store.consume(exactOperation);
    } catch {
      if (!currentEpoch(runEpoch)) return false;
      throw setFailure('VOICE_ACCEPTANCE_CLEANUP_FAILED', { phase: 'accepted-cleanup-pending' });
    }
    if (!currentEpoch(runEpoch)) return false;
    if (!consumed) {
      throw setFailure('VOICE_ACCEPTANCE_CLEANUP_FAILED', { phase: 'accepted-cleanup-pending' });
    }
    resetVisibleVoice();
    state.phase = 'ready';
    notify();
    return true;
  }

  async function remove() {
    assertUsable();
    if (!state.operation) return { state: 'idle' };
    const rejectedBinding = state.phase === 'error'
      && state.error?.code === 'VOICE_SEND_REJECTED'
      && state.binding
      && state.draft
      ? {
          clientUploadId: state.operation.clientUploadId,
          clientSessionScope: state.clientSessionScope,
          voiceDraftId: state.draft.voiceDraftId,
          clientMessageId: state.binding.clientMessageId,
          text: state.binding.text,
          replyLanguage: state.binding.replyLanguage,
          replyMode: state.binding.replyMode,
          nowMs: timestamp(),
        }
      : null;
    epoch += 1;
    const runEpoch = epoch;
    activeHold = null;
    try { observeMaybePromise(capture.cancel('visible-cancel')); } catch { /* cancellation is best effort; epoch is authoritative */ }
    state.phase = 'removing';
    state.error = null;
    notify();
    if (rejectedBinding) {
      let released;
      try {
        released = await store.releaseMessageBinding(rejectedBinding);
      } catch {
        if (!currentEpoch(runEpoch)) return { state: 'stale' };
        throw setFailure('VOICE_REMOVE_FAILED');
      }
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      if (!released
        || released.clientUploadId !== rejectedBinding.clientUploadId
        || released.clientSessionScope !== rejectedBinding.clientSessionScope
        || released.voiceDraftId !== rejectedBinding.voiceDraftId
        || released.messageBinding !== null) {
        throw setFailure('VOICE_REMOVE_BLOCKED', { phase: 'send-unconfirmed' });
      }
      state.binding = null;
    }
    let result;
    try {
      result = await coordinator.cancel({
        clientUploadId: state.operation.clientUploadId,
        clientSessionScope: state.clientSessionScope,
      });
    } catch {
      if (!currentEpoch(runEpoch)) return { state: 'stale' };
      throw setFailure('VOICE_REMOVE_FAILED');
    }
    if (!currentEpoch(runEpoch)) return { state: 'stale' };
    if (result?.state === 'idle' && state.binding) {
      throw setFailure('VOICE_REMOVE_BLOCKED', { phase: 'send-unconfirmed' });
    }
    if (['retryable', 'cancel_pending', 'lease_lost', 'disposed'].includes(result?.state)) {
      throw setFailure('VOICE_REMOVE_FAILED');
    }
    resetVisibleVoice();
    state.phase = 'ready';
    notify();
    return result ?? { state: 'idle' };
  }

  function dispose() {
    if (state.disposed) return;
    epoch += 1;
    activeHold = null;
    state.disposed = true;
    state.phase = 'disposed';
    state.permission = 'unknown';
    resetVisibleVoice();
    try { observeMaybePromise(capture.dispose()); } catch { /* disposal stays idempotent */ }
    try { observeMaybePromise(coordinator.dispose()); } catch { /* disposal stays idempotent */ }
    coordinatorStopped = true;
    notify();
  }

  return Object.freeze({
    beginHold,
    cancel,
    confirmConsent,
    dispose,
    finishHold,
    preflightPermission,
    reconcileChatSnapshot,
    remove,
    resume,
    retrySend,
    retryAcceptedCleanup,
    retryTranscription,
    sendDraft,
    setDraft,
    snapshot,
  });
}
