const DEFAULT_ASR_ERROR_NOTICE = '語音辨識暫時未能完成，請再錄一次或直接打字。';

export function createAsrErrorNotice(errorLike) {
  return errorLike?.payload?.userMessage
    || errorLike?.userMessage
    || DEFAULT_ASR_ERROR_NOTICE;
}

export function isVoiceInputAvailable(health) {
  const provider = String(health?.asrProvider || '').toLowerCase();
  return Boolean(health?.asrInputReady && (provider === 'azure' || provider === 'minimax'));
}

export function createVisitModeStartNotice({ voiceInputEnabled, readyMessage, voiceUnavailableHint }) {
  return voiceInputEnabled
    ? { text: readyMessage, kind: 'info' }
    : { text: voiceUnavailableHint, kind: 'warning' };
}
