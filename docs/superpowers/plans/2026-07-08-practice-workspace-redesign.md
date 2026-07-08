# Practice Workspace Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Practice page layout shown in the screenshot so the task, setup, coach, feedback, and conversation history panels never overlap or overflow.

**Architecture:** Keep the existing HTML and interaction model, but make the Practice page use explicit CSS grid areas. The old `#practice` anchor remains for existing JavaScript scroll calls, but it no longer creates visible layout space.

**Tech Stack:** Plain HTML/CSS/JS, Node regression scripts, Azure App Service zip deployment.

## Global Constraints

- Preserve the existing frontend/public sync model; edit `frontend` first, then sync to `backend/public`.
- Keep the interface fully interactive.
- Use the Intercom-inspired conversational structure and Linear-inspired precision from the installed Awesome DESIGN.md references.
- Update static asset query versions when CSS or module imports change.
- Verify locally and against the deployed Azure URL.

---

### Task 1: Lock The Broken Layout With A Contract

**Files:**
- Modify: `backend/scripts/test-v2-practice-contract.js`

**Interfaces:**
- Consumes: `backend/public/index.html`, `backend/public/styles.css`, `backend/public/app.js`
- Produces: Regression coverage for Practice grid placement, transcript metadata truncation, and mobile collapse.

- [x] **Step 1: Add failing assertions**

Add assertions that require named grid areas, non-visible legacy `#practice` anchor behavior, transcript pill truncation, and a single-column breakpoint at 1100px.

- [x] **Step 2: Verify red**

Run: `npm run test:v2-practice`

Expected: FAIL with `Practice desktop layout should use named grid areas instead of implicit placement`.

### Task 2: Redesign The Practice Workspace

**Files:**
- Modify: `frontend/styles.css`
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`
- Modify: `backend/scripts/test-visit-layout-contract.js`
- Modify: `backend/scripts/test-voice-disabled-ui.js`

**Interfaces:**
- Consumes: Existing `#practiceView`, `.practice-workspace-grid`, `.control-rail`, `.transcript`, `.feedback-panel`, and static asset version constants.
- Produces: Stable three-column desktop layout, one-column tablet/mobile layout, and cache-busted assets.

- [ ] **Step 1: Add explicit Practice grid areas**

Make `.practice-stage` define `task`, `setup`, `history`, `coach`, and `feedback`.

- [ ] **Step 2: Neutralize the nested grid**

Make `.practice-workspace-grid` use `display: contents` and make `.practice-conversation-slot` a hidden scroll anchor.

- [ ] **Step 3: Contain transcript metadata**

Allow `.transcript-meta` and `.pill` content to shrink and truncate instead of widening the panel.

- [ ] **Step 4: Add responsive collapse**

At `max-width: 1100px`, stack the areas in the order task, setup, history, coach, feedback.

- [ ] **Step 5: Bump static asset query version**

Replace `20260708v2uiux1` with `20260708practice1` in frontend HTML/JS and matching tests.

### Task 3: Sync, Verify, Deploy

**Files:**
- Generated sync target: `backend/public/*`

**Interfaces:**
- Consumes: frontend source files.
- Produces: deploy-ready backend public assets and verified Azure release.

- [ ] **Step 1: Sync frontend to backend public**

Run: `npm run sync:frontend`

- [ ] **Step 2: Verify regression suite**

Run: `npm run test:regressions`

- [ ] **Step 3: Run local browser smoke**

Open the local App Service backend page, switch to Practice, and check desktop and mobile for no overlap or horizontal overflow.

- [ ] **Step 4: Deploy to Azure**

Package `HEAD:backend` and deploy to `hkbuddy-pilot-0630`.

- [ ] **Step 5: Verify live browser smoke**

Check live static assets, Practice layout, and live translation still work.
