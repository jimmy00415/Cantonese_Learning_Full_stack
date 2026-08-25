export function startErrorCopy() {
  return 'The chat could not start. Check your connection and refresh to try again.';
}

export function sendErrorCopy(error = {}) {
  if (error.code === 'CHAT_NOT_READY') {
    return 'The chat is changing. Wait until the conversation is ready before trying again.';
  }
  if (error.code === 'SESSION_RECOVERED') {
    return 'A new guest chat is ready. Your draft was kept; send it again when you are ready.';
  }
  if (error.code === 'SESSION_RECOVERY_FAILED') {
    return 'Your guest session expired. Your draft is kept here, but a new chat could not start yet. Refresh to try again.';
  }
  if (error.code === 'RATE_LIMITED' || error.status === 429) {
    return error.retryAfter
      ? `Your message was not accepted. Wait ${error.retryAfter} seconds before sending again.`
      : 'Your message was not accepted. Wait a moment before sending again.';
  }
  if (Number.isSafeInteger(error.status) && error.status >= 400 && error.status < 500) {
    return 'Your message was not accepted. Edit the draft if needed, then send it again.';
  }
  return 'Send not confirmed. Your draft is kept; use Retry send on the message.';
}

export function clearErrorCopy(error = {}) {
  if (error.code === 'CLEARED_RESTART_FAILED' || error.deleted === true) {
    return 'Conversation cleared. A new guest chat could not start yet; refresh to try again.';
  }
  if (error.code === 'CLEAR_OUTCOME_UNKNOWN') {
    return 'Clearing could not be confirmed. Refresh to check this guest chat before continuing.';
  }
  if (error.code === 'CLEAR_FAILED_RECOVERY_PENDING') {
    return 'The conversation was not cleared, and the existing chat could not be reloaded. Refresh to recover it.';
  }
  return 'The conversation was not cleared. Please try again.';
}
