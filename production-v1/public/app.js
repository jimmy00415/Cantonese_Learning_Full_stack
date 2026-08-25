import { createChatController } from './chat-controller.js';
import { clearErrorCopy, sendErrorCopy, startErrorCopy } from './chat-copy.js';
import { formatFreshness, shouldSubmitOnEnter, shouldSyncDraft, turnStatusMessage } from './chat-state.js';
import { createMessageElement } from './message-renderer.js';
import { reconcileMessageFeed } from './timeline-view.js';

const shell = document.querySelector('.chat-shell');
const messageList = document.querySelector('#message-list');
const messageFeed = document.querySelector('#message-feed');
const welcome = document.querySelector('#welcome');
const turnStatus = document.querySelector('#turn-status');
const connectionStatus = document.querySelector('#connection-status');
const composer = document.querySelector('#composer');
const messageInput = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const voiceButton = document.querySelector('#voice-button');
const feedback = document.querySelector('#composer-feedback');
const starterPrompts = [...document.querySelectorAll('.starter-prompt')];
const infoButton = document.querySelector('.info-button');
const infoSheet = document.querySelector('#assistant-info');
const closeButton = document.querySelector('.close-button');
const clearButton = document.querySelector('#clear-session');
const clearStatus = document.querySelector('#clear-status');
const knowledgeSnapshotDate = document.querySelector('#knowledge-snapshot-date');

let latestSnapshot = null;
let clearConfirmationTimer = null;
let clearArmed = false;
let uiFeedback = '';

function atBottom() {
  return messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 96;
}

function scrollToLatest() {
  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
}

function resizeComposer() {
  messageInput.style.height = 'auto';
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 120)}px`;
}

function setFeedback(text = '') {
  uiFeedback = text;
  feedback.textContent = text;
}

function connectionCopy(state) {
  if (state === 'connecting') return 'Connecting to your guest conversation…';
  if (state === 'reconnecting') return 'Reconnecting. Your saved messages stay here.';
  return '';
}

function render(snapshot) {
  const shouldStick = !latestSnapshot || atBottom();
  latestSnapshot = snapshot;
  shell.dataset.appState = snapshot.ready ? 'ready' : 'loading';
  messageFeed.setAttribute('aria-busy', 'true');

  reconcileMessageFeed(messageFeed, snapshot.messages, (message, { isLatestAssistant }) => (
    createMessageElement(document, message, { isLatestAssistant, onRetry: retryUnconfirmed })
  ));
  welcome.hidden = snapshot.messages.length > 0;
  messageFeed.setAttribute('aria-busy', 'false');

  turnStatus.textContent = turnStatusMessage(snapshot.activeTurn);
  const connectionText = connectionCopy(snapshot.connection);
  connectionStatus.textContent = connectionText;
  connectionStatus.hidden = !connectionText;
  knowledgeSnapshotDate.textContent = formatFreshness(snapshot.knowledgeSnapshotDate);
  if (snapshot.knowledgeSnapshotDate) knowledgeSnapshotDate.dateTime = snapshot.knowledgeSnapshotDate;
  else knowledgeSnapshotDate.removeAttribute('datetime');

  if (shouldSyncDraft(messageInput.value, snapshot.draft)) {
    messageInput.value = snapshot.draft;
    resizeComposer();
  }
  messageInput.disabled = !snapshot.ready;
  const sendInProgress = snapshot.messages.some((message) => message.sendState === 'sending');
  sendButton.disabled = !snapshot.ready || !snapshot.draft.trim() || sendInProgress;
  for (const prompt of starterPrompts) prompt.disabled = !snapshot.ready || sendInProgress;

  const voiceServerAvailable = snapshot.capabilities.voiceInput || snapshot.capabilities.voiceInputPreview;
  voiceButton.dataset.serverAvailable = String(voiceServerAvailable);
  voiceButton.textContent = voiceServerAvailable ? 'Voice setup pending' : 'Voice unavailable';
  voiceButton.disabled = true;

  feedback.textContent = uiFeedback;
  if (shouldStick) scrollToLatest();
}

const controller = createChatController({
  storage: window.sessionStorage,
  onChange: render,
});

async function sendText(text) {
  const normalized = text.trim();
  if (!normalized || !latestSnapshot?.ready) return;
  setFeedback('');
  try {
    await controller.sendText(normalized);
  } catch (error) {
    setFeedback(sendErrorCopy(error));
  }
}

async function retryUnconfirmed(clientMessageId) {
  setFeedback('');
  try {
    const retrying = controller.retryUnconfirmed(clientMessageId);
    if (retrying === false) {
      setFeedback('This accepted question cannot be resent. Start a new message if you want to try again.');
      return;
    }
    await retrying;
  } catch (error) {
    setFeedback(sendErrorCopy(error));
  }
}

function usePrompt(text) {
  controller.setDraft(text);
  messageInput.value = text;
  resizeComposer();
  void sendText(text);
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  void sendText(messageInput.value);
});

messageInput.addEventListener('input', () => {
  controller.setDraft(messageInput.value);
  resizeComposer();
});

messageInput.addEventListener('keydown', (event) => {
  const finePointer = window.matchMedia('(pointer: fine)').matches;
  if (!shouldSubmitOnEnter(event, finePointer)) return;
  event.preventDefault();
  void sendText(messageInput.value);
});

for (const prompt of starterPrompts) {
  prompt.addEventListener('click', () => usePrompt(prompt.dataset.prompt || prompt.textContent));
}

messageFeed.addEventListener('click', (event) => {
  const prompt = event.target.closest?.('.suggested-reply[data-prompt]');
  if (prompt) usePrompt(prompt.dataset.prompt);
});

infoButton.addEventListener('click', () => {
  clearStatus.textContent = '';
  infoSheet.showModal();
  infoButton.setAttribute('aria-expanded', 'true');
});

closeButton.addEventListener('click', () => infoSheet.close());
infoSheet.addEventListener('close', () => infoButton.setAttribute('aria-expanded', 'false'));
infoSheet.addEventListener('click', (event) => {
  if (event.target === infoSheet) infoSheet.close();
});

function resetClearConfirmation({ preserveStatus = false } = {}) {
  clearArmed = false;
  clearButton.disabled = false;
  clearButton.textContent = 'Clear conversation';
  if (!preserveStatus) clearStatus.textContent = '';
  if (clearConfirmationTimer) clearTimeout(clearConfirmationTimer);
  clearConfirmationTimer = null;
}

clearButton.addEventListener('click', async () => {
  if (!clearArmed) {
    await controller.clearSession({ confirmed: false });
    clearArmed = true;
    clearButton.textContent = 'Tap again to clear';
    clearStatus.textContent = 'Tap again to confirm. This revokes the current guest conversation.';
    clearConfirmationTimer = setTimeout(resetClearConfirmation, 5_000);
    return;
  }
  clearButton.disabled = true;
  setFeedback('');
  try {
    await controller.clearSession({ confirmed: true });
    resetClearConfirmation();
    infoSheet.close();
  } catch (error) {
    resetClearConfirmation({ preserveStatus: true });
    clearStatus.textContent = clearErrorCopy(error);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && latestSnapshot?.ready) {
    void controller.refresh().catch(() => undefined);
  }
});

window.addEventListener('pagehide', () => controller.dispose(), { once: true });

void controller.start().catch((error) => {
  const copy = startErrorCopy(error);
  connectionStatus.hidden = false;
  connectionStatus.textContent = copy;
  setFeedback(copy);
});
