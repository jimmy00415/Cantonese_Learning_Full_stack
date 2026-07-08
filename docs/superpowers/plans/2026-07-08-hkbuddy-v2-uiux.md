# Hong Kong Buddy V2 UI/UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the V2 paid-pilot UI/UX where Cantonese learning habit is the primary path and daily-life or community-visit translation is the secondary tool.

**Architecture:** Keep the existing Express backend and deployed static frontend in `backend/public`. Add V2 view state, habit state, and clearer workspace sections inside the current vanilla HTML/CSS/JS app instead of replacing the stack. Existing translation, ASR, TTS, and correction endpoints remain the behavioral source of truth.

**Tech Stack:** Node.js 18+, Express, vanilla ES modules, static HTML/CSS, existing MiniMax/Azure provider integration, Node `assert` regression scripts.

## Global Constraints

- Build Hong Kong Buddy V2 into a business-ready paid pilot experience where Cantonese learning habit is the primary product path and daily-life or community-visit translation is the secondary tool.
- The first screen should be the working product, not a marketing page.
- MiniMax should remain the preferred high-quality voice path.
- Voice input must be honest.
- The microphone must not be clickable until ASR is ready.
- The result must not present a generic fallback as a confident translation.
- Persist lightweight habit state in local storage only.
- Do not require account/auth in this V2 phase.
- Do not add user accounts, payments, server-side habit history, admin dashboard, new AI providers, backend replacement, or copied external brand assets.
- Every behavior change must follow test-first work: add or update a focused failing test, run it and confirm the expected failure, implement the smallest change, run the focused test, then run the relevant regression group.
- Do not revert existing user or previous generated changes.
- Stage only files changed for the current phase.
- Keep source edits separate from generated deployment artifacts.

---

## File Structure

- Modify `backend/public/index.html`: deployed V2 app shell, Today view, Practice view anchors, Translation workspace, Phrasebook/Privacy view anchors, asset version bump.
- Modify `backend/public/app.js`: V2 view state, habit state, navigation handlers, practice quick start, translation rendering state, voice/audio UI states, phrasebook actions.
- Modify `backend/public/styles.css`: V2 shell, warm product workspace surface, responsive layout, compact audio controls, mobile input safety.
- Modify `backend/public/i18n/index.js`: V2 copy for Today, navigation, practice outcomes, translation states, voice states, phrasebook review.
- Modify `backend/package.json`: add focused V2 test scripts and one combined V2 regression script.
- Create `backend/scripts/test-v2-shell-contract.js`: static contract for V2 navigation, Today view, habit state, and i18n keys.
- Create `backend/scripts/test-v2-practice-contract.js`: static contract for Practice workspace and learning habit loop.
- Create `backend/scripts/test-v2-translation-contract.js`: static contract for Translation workspace, paired cards, fallback/error states.
- Create `backend/scripts/test-v2-voice-audio-contract.js`: static contract for honest voice states and compact audio controls.
- Create `backend/scripts/test-v2-phrasebook-review-contract.js`: static contract for phrasebook-to-practice and local habit review.
- Create `backend/scripts/test-v2-regression-suite.js`: runs existing visit regressions plus new V2 contracts in a deterministic order.

Implementation starts in `backend/public` because it is the deployed frontend. Do not mirror changes into `frontend/` or root-level `app.js` in these tasks unless a later explicit sync task is created and verified.

## Task 1: V2 App Shell And Today View

**Files:**
- Create: `backend/scripts/test-v2-shell-contract.js`
- Modify: `backend/package.json`
- Modify: `backend/public/index.html`
- Modify: `backend/public/app.js`
- Modify: `backend/public/styles.css`
- Modify: `backend/public/i18n/index.js`

**Interfaces:**
- Consumes: existing `t`, `setLanguage`, `getLanguage`, `loadTtsVoices`, `checkHealth`, `selectUserMode`, `startSession`, `translateVisitText`.
- Produces: `setAppView(viewName)`, `getHabitState()`, `saveHabitState(nextState)`, `renderTodayView()`, `V2_HABIT_STORAGE_KEY`, DOM ids `todayView`, `practiceView`, `translateView`, `phrasebookView`, `privacyView`.

- [ ] **Step 1: Write the failing V2 shell contract test**

Create `backend/scripts/test-v2-shell-contract.js`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const i18n = readFileSync(join(__dirname, '..', 'public', 'i18n', 'index.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

for (const id of ['todayView', 'practiceView', 'translateView', 'phrasebookView', 'privacyView']) {
  assert.match(html, new RegExp(`id="${id}"`), `${id} should exist in V2 app shell`);
}

for (const view of ['today', 'practice', 'translate', 'phrasebook', 'privacy']) {
  assert.match(html, new RegExp(`data-app-view-target="${view}"`), `${view} nav target should exist`);
}

assert.match(html, /data-default-view="today"/, 'app shell should default to Today');
assert.match(html, /id="todayQuickStart"/, 'Today view should expose a quick-start action');
assert.match(html, /id="todayHabitState"/, 'Today view should expose habit state');
assert.match(html, /id="todayVoiceState"/, 'Today view should expose voice readiness');
assert.match(app, /const\s+V2_HABIT_STORAGE_KEY\s*=\s*['"]hkbuddy\.v2\.habitState['"]/, 'habit storage key should be explicit');
assert.match(app, /function\s+setAppView\s*\(/, 'setAppView should control top-level V2 navigation');
assert.match(app, /function\s+getHabitState\s*\(/, 'getHabitState should read local habit state');
assert.match(app, /function\s+saveHabitState\s*\(/, 'saveHabitState should persist local habit state');
assert.match(app, /function\s+renderTodayView\s*\(/, 'renderTodayView should update Today cards');
assert.match(css, /\.v2-shell\b/, 'V2 shell styling should exist');
assert.match(css, /\.today-dashboard\b/, 'Today dashboard styling should exist');
assert.match(css, /@media\s*\(max-width:\s*980px\)/, 'responsive breakpoint should be present');
assert.match(i18n, /v2:\s*{/, 'V2 i18n namespace should exist');
assert.match(i18n, /today:\s*{/, 'Today copy should exist in i18n');
assert.equal(pkg.scripts['test:v2-shell'], 'node scripts/test-v2-shell-contract.js');

console.log('V2 shell contract passed');
```

- [ ] **Step 2: Run the failing shell test**

Run:

```bash
npm run test:v2-shell
```

Expected: fail because `test:v2-shell` is not in `backend/package.json` or because `todayView` and V2 helpers do not exist yet.

- [ ] **Step 3: Add the test script**

Modify `backend/package.json` inside `scripts`:

```json
"test:v2-shell": "node scripts/test-v2-shell-contract.js"
```

- [ ] **Step 4: Add V2 shell markup**

Modify `backend/public/index.html`.

Replace the current hero-first structure under `<main class="app">` with a V2 app shell that keeps existing sections available. Insert this block immediately after the closing `</header>`:

```html
<nav class="v2-shell" aria-label="Hong Kong Buddy workspace" data-default-view="today">
  <button type="button" class="v2-nav-item active" data-app-view-target="today" aria-current="page" data-i18n="v2.nav.today">Today</button>
  <button type="button" class="v2-nav-item" data-app-view-target="practice" data-i18n="v2.nav.practice">Practice</button>
  <button type="button" class="v2-nav-item" data-app-view-target="translate" data-i18n="v2.nav.translate">Translate</button>
  <button type="button" class="v2-nav-item" data-app-view-target="phrasebook" data-i18n="v2.nav.phrasebook">Phrasebook</button>
  <button type="button" class="v2-nav-item" data-app-view-target="privacy" data-i18n="v2.nav.privacy">Privacy</button>
</nav>

<section class="today-dashboard app-view active" id="todayView" data-app-view="today" aria-labelledby="todayTitle">
  <div class="today-primary">
    <p class="section-eyebrow" data-i18n="v2.today.eyebrow">Today</p>
    <h2 id="todayTitle" data-i18n="v2.today.title">Practise one Cantonese line today</h2>
    <p data-i18n="v2.today.body">Build a small daily habit first. Translate when you need real-life help.</p>
    <div class="today-actions">
      <button type="button" id="todayQuickStart" class="today-action-primary" data-i18n="v2.today.quickStart">Start today's practice</button>
      <button type="button" id="todayTranslateShortcut" class="today-action-secondary" data-app-view-target="translate" data-i18n="v2.today.translateShortcut">Open translator</button>
    </div>
  </div>
  <div class="today-card-grid" aria-label="Today status">
    <article class="today-card">
      <span data-i18n="v2.today.habitLabel">Habit</span>
      <strong id="todayHabitState" data-i18n="v2.today.habitEmpty">Not practised yet</strong>
    </article>
    <article class="today-card">
      <span data-i18n="v2.today.taskLabel">Recommended</span>
      <strong id="todayTaskState" data-i18n="v2.today.taskDefault">Ask someone to speak slower</strong>
    </article>
    <article class="today-card">
      <span data-i18n="v2.today.voiceLabel">Voice</span>
      <strong id="todayVoiceState" data-i18n="v2.today.voiceChecking">Checking voice...</strong>
    </article>
  </div>
</section>
```

Wrap the existing `practice-stage` section with the app-view class:

```html
<section class="practice-stage app-view" id="practiceView" data-app-view="practice" aria-label="Cantonese practice workspace">
```

Wrap or replace the existing visit translation panel's parent visibility by adding a translation view section before `practice-stage`:

```html
<section class="translate-workspace app-view" id="translateView" data-app-view="translate" aria-labelledby="translateViewTitle">
  <div class="translate-view-copy">
    <p class="section-eyebrow" data-i18n="v2.translate.eyebrow">Translate</p>
    <h2 id="translateViewTitle" data-i18n="v2.translate.title">Daily-life visit translator</h2>
    <p data-i18n="v2.translate.body">Use this when a resident, volunteer, or student needs fast meaning support.</p>
  </div>
</section>
```

Add view anchors for Phrasebook and Privacy near the existing dialogs:

```html
<section class="phrasebook-workspace app-view" id="phrasebookView" data-app-view="phrasebook" aria-labelledby="phrasebookViewTitle">
  <p class="section-eyebrow" data-i18n="v2.phrasebook.eyebrow">Phrasebook</p>
  <h2 id="phrasebookViewTitle" data-i18n="v2.phrasebook.title">Useful Cantonese lines</h2>
  <p data-i18n="v2.phrasebook.body">Pick a safe line for practice or visit support.</p>
</section>

<section class="privacy-workspace app-view" id="privacyView" data-app-view="privacy" aria-labelledby="privacyViewTitle">
  <p class="section-eyebrow" data-i18n="v2.privacy.eyebrow">Privacy</p>
  <h2 id="privacyViewTitle" data-i18n="v2.privacy.title">Privacy and AI limits</h2>
  <p data-i18n="v2.privacy.body">Avoid sensitive personal, medical, legal, or student-identifying information.</p>
</section>
```

- [ ] **Step 5: Add V2 shell state helpers**

Modify `backend/public/app.js` near the top-level element constants:

```js
const appViewButtons = document.querySelectorAll('[data-app-view-target]');
const appViews = document.querySelectorAll('[data-app-view]');
const todayQuickStart = document.getElementById('todayQuickStart');
const todayTranslateShortcut = document.getElementById('todayTranslateShortcut');
const todayHabitState = document.getElementById('todayHabitState');
const todayTaskState = document.getElementById('todayTaskState');
const todayVoiceState = document.getElementById('todayVoiceState');
const V2_HABIT_STORAGE_KEY = 'hkbuddy.v2.habitState';
let currentAppView = 'today';
```

Add these helpers before `initUserMode()`:

```js
function getTodayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function getHabitState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(V2_HABIT_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveHabitState(nextState) {
  localStorage.setItem(V2_HABIT_STORAGE_KEY, JSON.stringify(nextState || {}));
}

function renderTodayView() {
  const habit = getHabitState();
  const todayKey = getTodayKey();
  const practisedToday = habit.lastPractisedDate === todayKey;
  if (todayHabitState) {
    todayHabitState.textContent = practisedToday ? t('v2.today.habitDone') : t('v2.today.habitEmpty');
  }
  if (todayTaskState) {
    todayTaskState.textContent = t('v2.today.taskDefault');
  }
  if (todayVoiceState) {
    todayVoiceState.textContent = voiceInputEnabled ? t('v2.today.voiceReady') : t('v2.today.voiceTyping');
  }
}

function setAppView(viewName) {
  currentAppView = viewName || 'today';
  document.body.dataset.appView = currentAppView;
  appViews.forEach((view) => {
    const active = view.dataset.appView === currentAppView;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });
  appViewButtons.forEach((button) => {
    const active = button.dataset.appViewTarget === currentAppView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  if (currentAppView === 'today') renderTodayView();
  if (currentAppView === 'translate') selectUserMode('visit_translation');
  if (currentAppView === 'practice' && currentUserMode === 'visit_translation') selectUserMode('international_student');
}
```

Add event listeners near the existing startup listeners:

```js
appViewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setAppView(button.dataset.appViewTarget || 'today');
  });
});

todayQuickStart?.addEventListener('click', () => {
  selectUserMode(currentUserMode && currentUserMode !== 'visit_translation' ? currentUserMode : 'international_student');
  setAppView('practice');
  textInput?.focus();
});

todayTranslateShortcut?.addEventListener('click', () => {
  setAppView('translate');
});
```

Call `renderTodayView()` after health and voice loading update `voiceInputEnabled`, and call `setAppView('today')` during startup after `initUserMode()`.

- [ ] **Step 6: Add V2 shell styles**

Modify `backend/public/styles.css`:

```css
.v2-shell {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 16px auto 0;
  max-width: 1280px;
  padding: 8px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.82);
}

.v2-nav-item {
  min-height: 44px;
  padding: 0 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-soft);
  box-shadow: none;
  font-size: 14px;
}

.v2-nav-item.active {
  border-color: rgba(17, 24, 39, 0.16);
  background: #111827;
  color: #fff;
}

.app-view[hidden] {
  display: none !important;
}

.today-dashboard {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
  gap: 20px;
  margin: 20px auto;
  max-width: 1280px;
  padding: 24px;
  border: 1px solid rgba(17, 24, 39, 0.12);
  border-radius: 12px;
  background: #fff;
}

.today-primary h2 {
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(32px, 5vw, 58px);
  line-height: 1.04;
  letter-spacing: 0;
}

.today-primary p {
  max-width: 58ch;
}

.today-actions,
.today-card-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.today-action-primary,
.today-action-secondary {
  min-height: 44px;
  border-radius: 8px;
  box-shadow: none;
}

.today-action-primary {
  background: #111827;
  color: #fff;
}

.today-action-secondary {
  border: 1px solid var(--line);
  background: #fff;
  color: var(--ink);
}

.today-card-grid {
  align-content: start;
}

.today-card {
  flex: 1 1 180px;
  min-height: 112px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #f8fafc;
}

.today-card span {
  display: block;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
}

.today-card strong {
  display: block;
  color: var(--ink);
  font-size: 18px;
  line-height: 1.25;
}

@media (max-width: 980px) {
  .today-dashboard {
    grid-template-columns: 1fr;
    padding: 18px;
  }

  .v2-shell {
    position: sticky;
    top: 0;
    z-index: 20;
  }
}
```

- [ ] **Step 7: Add V2 copy**

Modify each locale in `backend/public/i18n/index.js` by adding this `v2` namespace. Use the same keys in all three locales, translating copy naturally:

```js
v2: {
  nav: {
    today: 'Today',
    practice: 'Practice',
    translate: 'Translate',
    phrasebook: 'Phrasebook',
    privacy: 'Privacy'
  },
  today: {
    eyebrow: 'Today',
    title: 'Practise one Cantonese line today',
    body: 'Build a small daily habit first. Translate when you need real-life help.',
    quickStart: "Start today's practice",
    translateShortcut: 'Open translator',
    habitLabel: 'Habit',
    habitEmpty: 'Not practised yet',
    habitDone: 'Practised today',
    taskLabel: 'Recommended',
    taskDefault: 'Ask someone to speak slower',
    voiceLabel: 'Voice',
    voiceChecking: 'Checking voice...',
    voiceReady: 'Voice input ready',
    voiceTyping: 'Typing-first mode'
  },
  translate: {
    eyebrow: 'Translate',
    title: 'Daily-life visit translator',
    body: 'Use this when a resident, volunteer, or student needs fast meaning support.'
  },
  phrasebook: {
    eyebrow: 'Phrasebook',
    title: 'Useful Cantonese lines',
    body: 'Pick a safe line for practice or visit support.'
  },
  privacy: {
    eyebrow: 'Privacy',
    title: 'Privacy and AI limits',
    body: 'Avoid sensitive personal, medical, legal, or student-identifying information.'
  }
}
```

- [ ] **Step 8: Verify shell test passes**

Run:

```bash
npm run test:v2-shell
```

Expected: `V2 shell contract passed`.

- [ ] **Step 9: Run existing visit regressions**

Run:

```bash
npm run test:visit-direction-routing
npm run test:visit-translation-quality
npm run test:visit-layout-contract
npm run test:voice-disabled-ui
node --check public/app.js
node --check public/i18n/index.js
```

Expected: all pass with no syntax errors.

- [ ] **Step 10: Commit Phase 1**

```bash
git add backend/package.json backend/public/index.html backend/public/app.js backend/public/styles.css backend/public/i18n/index.js backend/scripts/test-v2-shell-contract.js
git commit -m "feat: add v2 today app shell"
```

## Task 2: Practice Workspace And Learning Habit Loop

**Files:**
- Create: `backend/scripts/test-v2-practice-contract.js`
- Modify: `backend/package.json`
- Modify: `backend/public/index.html`
- Modify: `backend/public/app.js`
- Modify: `backend/public/styles.css`
- Modify: `backend/public/i18n/index.js`

**Interfaces:**
- Consumes: Task 1 `setAppView`, `getHabitState`, `saveHabitState`.
- Produces: `startPracticeFromToday()`, `markHabitPractised()`, `renderPracticeOutcomeMode()`, DOM ids `practiceTaskCard`, `practiceCoachPanel`, `practiceInputDock`.

- [ ] **Step 1: Write the failing practice contract test**

Create `backend/scripts/test-v2-practice-contract.js`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const i18n = readFileSync(join(__dirname, '..', 'public', 'i18n', 'index.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

assert.match(html, /id="practiceTaskCard"/, 'Practice should show the current task card');
assert.match(html, /id="practiceCoachPanel"/, 'Practice should show coach notes panel');
assert.match(html, /id="practiceInputDock"/, 'Practice input dock should wrap input and audio controls');
assert.match(html, /data-practice-mode="habit"/, 'Practice should expose a habit-first mode');
assert.match(app, /function\s+startPracticeFromToday\s*\(/, 'startPracticeFromToday should exist');
assert.match(app, /function\s+markHabitPractised\s*\(/, 'markHabitPractised should exist');
assert.match(app, /function\s+renderPracticeOutcomeMode\s*\(/, 'practice mode rendering helper should exist');
assert.match(app, /markHabitPractised\(\)/, 'successful user exchange should mark habit practised');
assert.match(css, /\.practice-workspace-grid\b/, 'practice workspace grid styling should exist');
assert.match(css, /\.practice-input-dock\b/, 'practice input dock styling should exist');
assert.match(i18n, /practice:\s*{/, 'V2 practice copy should exist');
assert.equal(pkg.scripts['test:v2-practice'], 'node scripts/test-v2-practice-contract.js');

console.log('V2 practice contract passed');
```

- [ ] **Step 2: Run the failing practice test**

Run:

```bash
npm run test:v2-practice
```

Expected: fail because the script or practice V2 ids do not exist yet.

- [ ] **Step 3: Add the package script**

Modify `backend/package.json`:

```json
"test:v2-practice": "node scripts/test-v2-practice-contract.js"
```

- [ ] **Step 4: Add practice workspace ids and structure**

Modify `backend/public/index.html` inside `practiceView`:

```html
<div class="practice-workspace-grid" data-practice-mode="habit">
  <aside class="practice-task-card" id="practiceTaskCard" aria-labelledby="practiceTaskTitle">
    <p class="section-eyebrow" data-i18n="v2.practice.eyebrow">Practice</p>
    <h2 id="practiceTaskTitle" data-i18n="v2.practice.taskTitle">Today's Cantonese line</h2>
    <p data-i18n="v2.practice.taskBody">Practise asking someone to speak a little slower.</p>
  </aside>
  <div class="practice-conversation-slot" id="practiceConversationSlot"></div>
  <aside class="practice-coach-panel" id="practiceCoachPanel">
    <p class="section-eyebrow" data-i18n="v2.practice.coachEyebrow">Coach</p>
    <h3 data-i18n="v2.practice.coachTitle">One useful note</h3>
    <p id="practiceCoachSummary" data-i18n="v2.practice.coachEmpty">Send one line to get a focused note.</p>
  </aside>
</div>
```

Wrap the existing bottom input panel with id `practiceInputDock`:

```html
<section class="input-panel practice-input-dock" id="practiceInputDock" aria-label="Practice input">
```

- [ ] **Step 5: Add practice helpers**

Modify `backend/public/app.js`:

```js
function markHabitPractised() {
  const habit = getHabitState();
  const todayKey = getTodayKey();
  saveHabitState({
    ...habit,
    lastPractisedDate: todayKey,
    completedCount: Number(habit.completedCount || 0) + 1
  });
  renderTodayView();
}

function renderPracticeOutcomeMode() {
  const label = currentMode === 'teaching'
    ? t('v2.practice.modeTeaching')
    : currentMode === 'freeChat'
      ? t('v2.practice.modeFree')
      : t('v2.practice.modeHabit');
  const coachSummary = document.getElementById('practiceCoachSummary');
  if (coachSummary && !lastUserUtterance) {
    coachSummary.textContent = t('v2.practice.coachEmpty');
  }
  if (scenarioPill && !isVisitTranslationMode()) {
    scenarioPill.textContent = label;
  }
}

async function startPracticeFromToday() {
  selectUserMode(currentUserMode && currentUserMode !== 'visit_translation' ? currentUserMode : 'international_student');
  setActiveMode('teaching');
  setAppView('practice');
  renderPracticeOutcomeMode();
  if (!sessionId) await startSession();
  textInput?.focus();
}
```

Change the `todayQuickStart` click handler from Task 1 to call:

```js
todayQuickStart?.addEventListener('click', () => {
  startPracticeFromToday().catch((err) => {
    console.error(err);
    setNotice(t('v2.practice.startFailed'), 'error');
  });
});
```

In `sendUtterance(text)`, after a successful non-visit tutor response and after `renderMessage({ role: 'ai', ... })`, add:

```js
markHabitPractised();
renderPracticeOutcomeMode();
```

- [ ] **Step 6: Add practice styles**

Modify `backend/public/styles.css`:

```css
.practice-workspace-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.34fr) minmax(0, 1fr) minmax(260px, 0.32fr);
  gap: 16px;
  align-items: start;
}

.practice-task-card,
.practice-coach-panel {
  padding: 18px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
}

.practice-task-card h2,
.practice-coach-panel h3 {
  margin: 0 0 8px;
  letter-spacing: 0;
}

.practice-input-dock {
  border-radius: 12px;
}

@media (max-width: 980px) {
  .practice-workspace-grid {
    grid-template-columns: 1fr;
  }

  .practice-coach-panel {
    order: 3;
  }
}
```

- [ ] **Step 7: Add practice copy**

Add to each locale under `v2`:

```js
practice: {
  eyebrow: 'Practice',
  taskTitle: "Today's Cantonese line",
  taskBody: 'Practise asking someone to speak a little slower.',
  coachEyebrow: 'Coach',
  coachTitle: 'One useful note',
  coachEmpty: 'Send one line to get a focused note.',
  modeHabit: 'Daily practice',
  modeTeaching: 'Correction practice',
  modeFree: 'Free talk',
  startFailed: 'Practice could not start. Please try again.'
}
```

- [ ] **Step 8: Verify practice test passes**

Run:

```bash
npm run test:v2-practice
```

Expected: `V2 practice contract passed`.

- [ ] **Step 9: Run related regression commands**

```bash
npm run test:v2-shell
npm run test:v2-practice
npm run test:voice-disabled-ui
node --check public/app.js
node --check public/i18n/index.js
```

Expected: all pass.

- [ ] **Step 10: Commit Phase 2**

```bash
git add backend/package.json backend/public/index.html backend/public/app.js backend/public/styles.css backend/public/i18n/index.js backend/scripts/test-v2-practice-contract.js
git commit -m "feat: add v2 practice workspace"
```

## Task 3: Translation Workspace And Result States

**Files:**
- Create: `backend/scripts/test-v2-translation-contract.js`
- Modify: `backend/package.json`
- Modify: `backend/public/index.html`
- Modify: `backend/public/app.js`
- Modify: `backend/public/styles.css`
- Modify: `backend/public/i18n/index.js`

**Interfaces:**
- Consumes: existing `translateVisitText`, `renderVisitTranslation`, `syncVisitDirectionControls`, `isGenericVisitTranslationText`.
- Produces: `visitTranslationState`, `renderVisitInputCard(sourceText, inputType, direction)`, `renderVisitError(error, sourceText)`, DOM ids `visitInputCard`, `visitOutputCard`, `visitRetryBtn`.

- [ ] **Step 1: Write the failing translation contract test**

Create `backend/scripts/test-v2-translation-contract.js`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const i18n = readFileSync(join(__dirname, '..', 'public', 'i18n', 'index.js'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

assert.match(html, /id="visitInputCard"/, 'Translation workspace should keep input visible');
assert.match(html, /id="visitOutputCard"/, 'Translation workspace should render output in paired card');
assert.match(html, /id="visitRetryBtn"/, 'Translation workspace should expose retry action');
assert.match(app, /let\s+visitTranslationState\s*=/, 'visitTranslationState should track last request');
assert.match(app, /function\s+renderVisitInputCard\s*\(/, 'renderVisitInputCard should exist');
assert.match(app, /function\s+renderVisitError\s*\(/, 'renderVisitError should exist');
assert.match(app, /renderVisitInputCard\(text,\s*inputType,\s*direction\)/, 'translateVisitText should render input before request');
assert.match(app, /renderVisitError\(err,\s*text\)/, 'translateVisitText should render failed request state');
assert.match(css, /\.visit-pair-grid\b/, 'paired translation grid styling should exist');
assert.match(css, /\.visit-result-state-error\b/, 'error result styling should exist');
assert.match(css, /\.visit-result-state-fallback\b/, 'fallback result styling should exist');
assert.match(i18n, /retryTranslation:/, 'retry copy should exist');
assert.equal(pkg.scripts['test:v2-translation'], 'node scripts/test-v2-translation-contract.js');

console.log('V2 translation contract passed');
```

- [ ] **Step 2: Run the failing translation test**

```bash
npm run test:v2-translation
```

Expected: fail because the script or paired translation elements are missing.

- [ ] **Step 3: Add the package script**

Modify `backend/package.json`:

```json
"test:v2-translation": "node scripts/test-v2-translation-contract.js"
```

- [ ] **Step 4: Add paired cards to translation markup**

Modify `backend/public/index.html` inside `translateView`:

```html
<div class="visit-pair-grid" aria-label="Visit translation result">
  <article class="visit-pair-card" id="visitInputCard">
    <span class="visit-output-kicker" data-i18n="v2.translate.inputLabel">Input</span>
    <strong data-i18n="v2.translate.inputEmpty">No input yet</strong>
    <p data-i18n="v2.translate.inputHint">Type or record the sentence to translate.</p>
  </article>
  <article class="visit-pair-card" id="visitOutputCard">
    <span class="visit-output-kicker" data-i18n="v2.translate.outputLabel">Output</span>
    <strong data-i18n="visitTranslate.outputTitle">Choose a task above</strong>
    <p data-i18n="visitTranslate.outputEmpty">Then type or hold the microphone to translate.</p>
    <button type="button" id="visitRetryBtn" class="visit-retry-btn" hidden data-i18n="v2.translate.retryTranslation">Retry translation</button>
  </article>
</div>
```

Move or visually include the existing `visitTranslatePanel` inside `translateView` so the task cards and paired output live in one workspace.

- [ ] **Step 5: Add translation state helpers**

Modify `backend/public/app.js` near visit constants:

```js
const visitInputCard = document.getElementById('visitInputCard');
const visitOutputCard = document.getElementById('visitOutputCard');
const visitRetryBtn = document.getElementById('visitRetryBtn');
let visitTranslationState = {
  sourceText: '',
  inputType: 'text',
  direction: DEFAULT_VISIT_DIRECTION,
  status: 'empty'
};
```

Add helpers before `translateVisitText`:

```js
function renderVisitInputCard(sourceText, inputType, direction) {
  if (!visitInputCard) return;
  const meta = getVisitDirectionMeta(direction);
  visitInputCard.innerHTML = '';
  appendTextElement(visitInputCard, 'span', t('v2.translate.inputLabel'), 'visit-output-kicker');
  appendTextElement(visitInputCard, 'strong', sourceText || t('v2.translate.inputEmpty'));
  appendTextElement(visitInputCard, 'p', `${t(meta.routeKey)} · ${inputType === 'speech' ? t('v2.translate.inputSpeech') : t('v2.translate.inputTyped')}`);
}

function renderVisitError(error, sourceText) {
  if (!visitOutputCard) return;
  visitOutputCard.className = 'visit-pair-card visit-result-state-error';
  visitOutputCard.innerHTML = '';
  appendTextElement(visitOutputCard, 'span', t('v2.translate.failedLabel'), 'visit-output-kicker');
  appendTextElement(visitOutputCard, 'strong', t('visitTranslate.notices.failed'));
  appendTextElement(visitOutputCard, 'p', error?.message || t('v2.translate.failedBody'));
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.id = 'visitRetryBtn';
  retry.className = 'visit-retry-btn';
  retry.textContent = t('v2.translate.retryTranslation');
  retry.addEventListener('click', () => translateVisitText(sourceText, visitTranslationState.inputType || 'text'));
  visitOutputCard.appendChild(retry);
}
```

At the start of `translateVisitText(text, inputType = 'text')`, after `const direction = ...`, add:

```js
visitTranslationState = { sourceText: text, inputType, direction, status: 'pending' };
renderVisitInputCard(text, inputType, direction);
```

In the `catch (err)` branch of `translateVisitText`, add before `setNotice`:

```js
visitTranslationState = { ...visitTranslationState, status: 'error' };
renderVisitError(err, text);
```

In `renderVisitTranslation(res)`, mirror the existing output into `visitOutputCard`:

```js
if (visitOutputCard) {
  const displayText = res.displayText || res.translatedText || '';
  const fallbackResult = res.provider === 'mock' || isGenericVisitTranslationText(displayText);
  visitOutputCard.className = `visit-pair-card ${fallbackResult ? 'visit-result-state-fallback' : 'visit-result-state-success'}`;
  visitOutputCard.innerHTML = '';
  appendTextElement(visitOutputCard, 'span', fallbackResult ? t('v2.translate.confirmLabel') : t('v2.translate.outputLabel'), 'visit-output-kicker');
  appendTextElement(visitOutputCard, 'strong', displayText || t('visitTranslate.outputEmpty'));
  if (res.autoRouted) appendTextElement(visitOutputCard, 'p', t('visitTranslate.autoRouted'), 'visit-route-note');
  if (res.needsConfirmation || fallbackResult) appendTextElement(visitOutputCard, 'p', t('visitTranslate.confirmationWarning'), 'visit-translation-warning');
}
```

- [ ] **Step 6: Add translation styles**

Modify `backend/public/styles.css`:

```css
.visit-pair-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 14px;
}

.visit-pair-card {
  min-height: 148px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
}

.visit-pair-card strong {
  display: block;
  margin: 8px 0;
  color: var(--ink);
  font-size: clamp(20px, 2vw, 28px);
  line-height: 1.18;
  overflow-wrap: anywhere;
}

.visit-result-state-success {
  border-color: rgba(22, 163, 74, 0.28);
  background: #f0fdf4;
}

.visit-result-state-fallback {
  border-color: rgba(180, 83, 9, 0.32);
  background: #fffbeb;
}

.visit-result-state-error {
  border-color: rgba(185, 28, 28, 0.32);
  background: #fef2f2;
}

.visit-retry-btn {
  min-height: 40px;
  border-radius: 8px;
  background: #111827;
  color: #fff;
}

@media (max-width: 980px) {
  .visit-pair-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 7: Add translation copy**

Add under `v2.translate` in each locale:

```js
inputLabel: 'Input',
inputEmpty: 'No input yet',
inputHint: 'Type or record the sentence to translate.',
inputSpeech: 'Speech',
inputTyped: 'Typed',
outputLabel: 'Output',
confirmLabel: 'Confirm with staff',
failedLabel: 'Translation failed',
failedBody: 'The request did not complete. Your input is still here.',
retryTranslation: 'Retry translation'
```

- [ ] **Step 8: Verify translation tests**

```bash
npm run test:v2-translation
npm run test:visit-direction-routing
npm run test:visit-translation-quality
npm run test:visit-http-routing
npm run test:visit-layout-contract
node --check public/app.js
node --check public/i18n/index.js
```

Expected: all pass.

- [ ] **Step 9: Commit Phase 3**

```bash
git add backend/package.json backend/public/index.html backend/public/app.js backend/public/styles.css backend/public/i18n/index.js backend/scripts/test-v2-translation-contract.js
git commit -m "feat: clarify v2 translation workspace"
```

## Task 4: Voice And Audio Control Reliability

**Files:**
- Create: `backend/scripts/test-v2-voice-audio-contract.js`
- Modify: `backend/package.json`
- Modify: `backend/public/index.html`
- Modify: `backend/public/app.js`
- Modify: `backend/public/styles.css`
- Modify: `backend/public/i18n/index.js`

**Interfaces:**
- Consumes: existing `voiceInputEnabled`, `updateInputLabelsForMode`, `loadTtsVoices`, `updateTtsPill`, `replayBtn`, `lastTtsAudio`.
- Produces: `VOICE_UI_STATES`, `setVoiceUiState(stateName)`, `updateReplayAvailability()`, DOM id `audioControlDock`.

- [ ] **Step 1: Write the failing voice/audio contract test**

Create `backend/scripts/test-v2-voice-audio-contract.js`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

assert.match(html, /id="audioControlDock"/, 'audio controls should be grouped in a named dock');
assert.match(app, /const\s+VOICE_UI_STATES\s*=\s*{/, 'VOICE_UI_STATES should exist');
assert.match(app, /function\s+setVoiceUiState\s*\(/, 'setVoiceUiState should exist');
assert.match(app, /function\s+updateReplayAvailability\s*\(/, 'updateReplayAvailability should exist');
assert.match(app, /setVoiceUiState\('unavailable'\)/, 'unavailable state should be set explicitly');
assert.match(app, /setVoiceUiState\('recording'\)/, 'recording state should be set explicitly');
assert.match(app, /setVoiceUiState\('processing'\)/, 'processing state should be set explicitly');
assert.match(app, /replayBtn\.disabled\s*=\s*!lastTtsAudio/, 'replay should be disabled without audio');
assert.match(css, /\.audio-control-dock\b/, 'audio dock styling should exist');
assert.match(css, /\.voice-state-unavailable\b/, 'unavailable voice state styling should exist');
assert.match(css, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'mobile-safe grid sizing should exist');
assert.equal(pkg.scripts['test:v2-voice-audio'], 'node scripts/test-v2-voice-audio-contract.js');

console.log('V2 voice/audio contract passed');
```

- [ ] **Step 2: Run the failing voice/audio test**

```bash
npm run test:v2-voice-audio
```

Expected: fail because the script or voice/audio state helpers are missing.

- [ ] **Step 3: Add the package script**

Modify `backend/package.json`:

```json
"test:v2-voice-audio": "node scripts/test-v2-voice-audio-contract.js"
```

- [ ] **Step 4: Name the audio dock**

Modify `backend/public/index.html`:

```html
<div class="audio-controls audio-control-dock" id="audioControlDock">
```

- [ ] **Step 5: Add voice UI states**

Modify `backend/public/app.js` near `STATES`:

```js
const VOICE_UI_STATES = {
  CHECKING: 'checking',
  AVAILABLE: 'available',
  UNAVAILABLE: 'unavailable',
  BLOCKED: 'blocked',
  RECORDING: 'recording',
  PROCESSING: 'processing',
  FAILED: 'failed'
};

function setVoiceUiState(stateName) {
  const state = stateName || VOICE_UI_STATES.CHECKING;
  document.body.dataset.voiceState = state;
  if (!holdBtn) return;
  holdBtn.classList.toggle('voice-state-unavailable', state === VOICE_UI_STATES.UNAVAILABLE);
  holdBtn.classList.toggle('voice-state-recording', state === VOICE_UI_STATES.RECORDING);
  holdBtn.classList.toggle('voice-state-processing', state === VOICE_UI_STATES.PROCESSING);
  if (state === VOICE_UI_STATES.UNAVAILABLE) {
    holdBtn.textContent = t('input.voiceUnavailable');
    holdBtn.title = t('input.voiceUnavailableHint');
  }
}

function updateReplayAvailability() {
  if (!replayBtn) return;
  replayBtn.disabled = !lastTtsAudio;
  replayBtn.setAttribute('aria-disabled', String(!lastTtsAudio));
}
```

In `setControlsEnabled`, after changing hold button disabled state, add:

```js
setVoiceUiState(voiceInputEnabled ? 'available' : 'unavailable');
```

In `handleRecordStart`, keep the existing guard and add:

```js
setVoiceUiState('unavailable');
```

inside the `if (!voiceInputEnabled)` branch before return.

When recording starts, add:

```js
setVoiceUiState('recording');
```

When speech is processing, add:

```js
setVoiceUiState('processing');
```

When ASR fails, add:

```js
setVoiceUiState(voiceInputEnabled ? 'available' : 'unavailable');
```

Call `updateReplayAvailability()` after any assignment to `lastTtsAudio`, after `clearChat`, and after startup.

- [ ] **Step 6: Add audio dock styles**

Modify `backend/public/styles.css`:

```css
.audio-control-dock {
  display: grid;
  grid-template-columns: auto auto auto auto;
  gap: 8px;
  align-items: center;
}

.voice-state-unavailable,
.mic.voice-state-unavailable {
  background: #e8eef7;
  color: #526070;
  border-color: #c8d4e3;
  cursor: not-allowed;
  pointer-events: none;
}

.voice-state-recording {
  background: #b91c1c;
  color: #fff;
}

.voice-state-processing {
  background: #92400e;
  color: #fff;
}

.audio-control-dock button:disabled {
  cursor: not-allowed;
  opacity: 0.62;
}

@media (max-width: 980px) {
  .audio-control-dock {
    grid-template-columns: minmax(0, 1fr);
    width: 100%;
  }
}
```

- [ ] **Step 7: Verify voice/audio tests**

```bash
npm run test:v2-voice-audio
npm run test:voice-disabled-ui
node --check public/app.js
```

Expected: all pass.

- [ ] **Step 8: Commit Phase 4**

```bash
git add backend/package.json backend/public/index.html backend/public/app.js backend/public/styles.css backend/public/i18n/index.js backend/scripts/test-v2-voice-audio-contract.js
git commit -m "feat: harden v2 voice audio controls"
```

## Task 5: Phrasebook And Local Review

**Files:**
- Create: `backend/scripts/test-v2-phrasebook-review-contract.js`
- Modify: `backend/package.json`
- Modify: `backend/public/index.html`
- Modify: `backend/public/app.js`
- Modify: `backend/public/styles.css`
- Modify: `backend/public/i18n/index.js`

**Interfaces:**
- Consumes: existing `elderlyVisitPlaybook`, `selectVisitPhrase`, `resetVisitPhrase`, `textInput`.
- Produces: `usePhraseForPractice(phraseText)`, `usePhraseForTranslation(phraseText)`, `renderHabitReview()`, DOM ids `phrasebookList`, `habitReviewPanel`.

- [ ] **Step 1: Write the failing phrasebook/review contract test**

Create `backend/scripts/test-v2-phrasebook-review-contract.js`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = readFileSync(join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

assert.match(html, /id="phrasebookList"/, 'Phrasebook view should have a list mount');
assert.match(html, /id="habitReviewPanel"/, 'Today or practice should expose habit review');
assert.match(app, /function\s+usePhraseForPractice\s*\(/, 'usePhraseForPractice should exist');
assert.match(app, /function\s+usePhraseForTranslation\s*\(/, 'usePhraseForTranslation should exist');
assert.match(app, /function\s+renderHabitReview\s*\(/, 'renderHabitReview should exist');
assert.match(app, /data-phrase-action/, 'phrase actions should be explicit');
assert.match(css, /\.phrasebook-grid\b/, 'phrasebook grid styling should exist');
assert.match(css, /\.habit-review-panel\b/, 'habit review styling should exist');
assert.equal(pkg.scripts['test:v2-phrasebook-review'], 'node scripts/test-v2-phrasebook-review-contract.js');

console.log('V2 phrasebook/review contract passed');
```

- [ ] **Step 2: Run the failing phrasebook test**

```bash
npm run test:v2-phrasebook-review
```

Expected: fail because phrasebook list and review helpers are not present yet.

- [ ] **Step 3: Add the package script**

Modify `backend/package.json`:

```json
"test:v2-phrasebook-review": "node scripts/test-v2-phrasebook-review-contract.js"
```

- [ ] **Step 4: Add phrasebook and review mounts**

Modify `backend/public/index.html` inside `todayView`:

```html
<aside class="habit-review-panel" id="habitReviewPanel" aria-live="polite">
  <span data-i18n="v2.review.label">Review</span>
  <strong data-i18n="v2.review.empty">Complete one line to unlock review.</strong>
</aside>
```

Modify `phrasebookView`:

```html
<div class="phrasebook-grid" id="phrasebookList" aria-label="Phrasebook actions"></div>
```

- [ ] **Step 5: Add phrasebook actions**

Modify `backend/public/app.js`:

```js
const phrasebookList = document.getElementById('phrasebookList');
const habitReviewPanel = document.getElementById('habitReviewPanel');

function usePhraseForPractice(phraseText) {
  setAppView('practice');
  selectUserMode(currentUserMode && currentUserMode !== 'visit_translation' ? currentUserMode : 'international_student');
  if (textInput) {
    textInput.value = phraseText || '';
    textInput.focus();
  }
}

function usePhraseForTranslation(phraseText) {
  setAppView('translate');
  selectUserMode('visit_translation');
  if (textInput) {
    textInput.value = phraseText || '';
    textInput.focus();
  }
}

function renderHabitReview() {
  if (!habitReviewPanel) return;
  const habit = getHabitState();
  const done = habit.lastPractisedDate === getTodayKey();
  habitReviewPanel.innerHTML = '';
  appendTextElement(habitReviewPanel, 'span', t('v2.review.label'));
  appendTextElement(habitReviewPanel, 'strong', done ? t('v2.review.done') : t('v2.review.empty'));
}

function renderPhrasebookView() {
  if (!phrasebookList) return;
  phrasebookList.innerHTML = '';
  elderlyVisitPlaybook.phrases.slice(0, 9).forEach((phrase) => {
    const card = document.createElement('article');
    card.className = 'phrasebook-card';
    card.innerHTML = `
      <strong>${phrase.cantonese}</strong>
      <span>${phrase.jyutping || ''}</span>
      <p>${phrase.english || phrase.meaning || ''}</p>
    `;
    const practiceButton = document.createElement('button');
    practiceButton.type = 'button';
    practiceButton.dataset.phraseAction = 'practice';
    practiceButton.textContent = t('v2.phrasebook.practiceAction');
    practiceButton.addEventListener('click', () => usePhraseForPractice(phrase.cantonese));
    const translateButton = document.createElement('button');
    translateButton.type = 'button';
    translateButton.dataset.phraseAction = 'translate';
    translateButton.textContent = t('v2.phrasebook.translateAction');
    translateButton.addEventListener('click', () => usePhraseForTranslation(phrase.cantonese));
    card.append(practiceButton, translateButton);
    phrasebookList.appendChild(card);
  });
}
```

Call `renderHabitReview()` inside `renderTodayView()` and after `markHabitPractised()`. Call `renderPhrasebookView()` during startup and whenever `setAppView('phrasebook')` activates the phrasebook view.

- [ ] **Step 6: Add phrasebook styles**

Modify `backend/public/styles.css`:

```css
.habit-review-panel {
  margin-top: 16px;
  padding: 14px;
  border: 1px solid rgba(22, 163, 74, 0.24);
  border-radius: 12px;
  background: #f0fdf4;
}

.habit-review-panel span {
  display: block;
  margin-bottom: 6px;
  color: #166534;
  font-size: 12px;
  font-weight: 800;
}

.phrasebook-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.phrasebook-card {
  display: grid;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: #fff;
}

.phrasebook-card strong,
.phrasebook-card span,
.phrasebook-card p {
  overflow-wrap: anywhere;
}

.phrasebook-card button {
  min-height: 40px;
  border-radius: 8px;
}

@media (max-width: 980px) {
  .phrasebook-grid {
    grid-template-columns: 1fr;
  }
}
```

- [ ] **Step 7: Add phrasebook/review copy**

Add under `v2` in each locale:

```js
review: {
  label: 'Review',
  empty: 'Complete one line to unlock review.',
  done: 'Today practised. Replay or save one phrase.'
},
phrasebook: {
  eyebrow: 'Phrasebook',
  title: 'Useful Cantonese lines',
  body: 'Pick a safe line for practice or visit support.',
  practiceAction: 'Practise this',
  translateAction: 'Use in translator'
}
```

- [ ] **Step 8: Verify phrasebook tests**

```bash
npm run test:v2-phrasebook-review
npm run test:v2-shell
npm run test:v2-practice
node --check public/app.js
node --check public/i18n/index.js
```

Expected: all pass.

- [ ] **Step 9: Commit Phase 5**

```bash
git add backend/package.json backend/public/index.html backend/public/app.js backend/public/styles.css backend/public/i18n/index.js backend/scripts/test-v2-phrasebook-review-contract.js
git commit -m "feat: connect v2 phrasebook review"
```

## Task 6: Business-Ready Regression Suite And Browser Verification

**Files:**
- Create: `backend/scripts/test-v2-regression-suite.js`
- Modify: `backend/package.json`
- Modify: `backend/public/styles.css`
- Modify: `backend/public/index.html`

**Interfaces:**
- Consumes: all previous V2 tests and existing visit tests.
- Produces: `npm run test:v2`, `npm run test:regressions`, final asset version string.

- [ ] **Step 1: Write the regression suite runner**

Create `backend/scripts/test-v2-regression-suite.js`:

```js
import { spawnSync } from 'node:child_process';

const commands = [
  ['node', ['scripts/test-v2-shell-contract.js']],
  ['node', ['scripts/test-v2-practice-contract.js']],
  ['node', ['scripts/test-v2-translation-contract.js']],
  ['node', ['scripts/test-v2-voice-audio-contract.js']],
  ['node', ['scripts/test-v2-phrasebook-review-contract.js']],
  ['node', ['scripts/test-visit-direction-routing.js']],
  ['node', ['scripts/test-visit-translation-quality.js']],
  ['node', ['scripts/test-visit-layout-contract.js']],
  ['node', ['scripts/test-voice-disabled-ui.js']],
  ['node', ['--check', 'server.js']],
  ['node', ['--check', 'public/app.js']],
  ['node', ['--check', 'public/i18n/index.js']],
  ['node', ['--check', 'public/errors.js']]
];

for (const [command, args] of commands) {
  const label = `${command} ${args.join(' ')}`;
  const result = spawnSync(command, args, {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    shell: process.platform === 'win32'
  });
  if (result.status !== 0) {
    throw new Error(`Regression command failed: ${label}`);
  }
}

console.log('V2 regression suite passed');
```

- [ ] **Step 2: Add package scripts**

Modify `backend/package.json`:

```json
"test:v2": "node scripts/test-v2-regression-suite.js",
"test:regressions": "node scripts/test-v2-regression-suite.js"
```

- [ ] **Step 3: Run suite and fix only suite wiring failures**

```bash
npm run test:v2
```

Expected: `V2 regression suite passed`. If a command fails because a script name is wrong, fix the runner or `package.json`. If product behavior fails, return to the task that owns that behavior and follow test-first debugging there.

- [ ] **Step 4: Bump deployed asset versions**

Modify `backend/public/index.html`:

```html
<link rel="stylesheet" href="styles.css?v=20260708v2uiux1" />
<script type="module" src="app.js?v=20260708v2uiux1"></script>
```

Update any static tests that assert the old asset version so they expect `20260708v2uiux1`.

- [ ] **Step 5: Run browser verification**

Start the app:

```bash
npm start
```

Use a browser or in-app browser against the printed localhost URL and verify:

- Today is first.
- Practice quick start opens Practice.
- Translate nav opens translator.
- Phrasebook renders phrase cards.
- Privacy view is visible.
- Mobile width around 390px has no overlapping input controls.
- Desktop width around 1440px has no overlapping cards.

Stop the server after verification.

- [ ] **Step 6: Run final regression suite**

```bash
npm run test:v2
```

Expected: `V2 regression suite passed`.

- [ ] **Step 7: Commit Phase 6**

```bash
git add backend/package.json backend/public/index.html backend/public/styles.css backend/scripts/test-v2-regression-suite.js backend/scripts/test-visit-layout-contract.js backend/scripts/test-voice-disabled-ui.js
git commit -m "test: add v2 regression suite"
```

## Plan Self-Review

Spec coverage:

- Today/default learning habit: Task 1.
- Practice workspace and habit loop: Task 2.
- Translation workspace and fallback/error distinction: Task 3.
- Honest voice and compact TTS/audio controls: Task 4.
- Phrasebook and local review: Task 5.
- Full regression and browser verification: Task 6.

No omitted spec item requires backend replacement, account creation, payments, or new AI providers.

Placeholder scan:

- No unfinished marker words or unspecified test commands are used.
- Each task has a focused failing test, expected failure, implementation snippets, verification commands, and commit boundary.

Type consistency:

- `V2_HABIT_STORAGE_KEY`, `getHabitState`, `saveHabitState`, `renderTodayView`, and `setAppView` are introduced in Task 1 and consumed later.
- `markHabitPractised` and `renderHabitReview` use the same local storage state shape.
- `visitTranslationState` is introduced before error retry uses it.
- Package scripts match the exact filenames created by each task.
