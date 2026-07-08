# Visit Translation Layout Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the V2 visit translation flow deterministic for common paid-pilot phrases and structurally isolated from old practice/hero layout components.

**Architecture:** Centralize visit translation rules in `backend/services/visitTranslationFallback.js`, keep `/api/visit-translate` as orchestration, and make Translate view self-contained with its own input strip. Regression tests must catch generic fallback, stale frontend/public sync, and old translate sections leaking into the V2 workspace.

**Tech Stack:** Node.js ESM backend, static HTML/CSS/JS frontend, existing script-based regression tests.

## Global Constraints

- Keep MiniMax as the preferred LLM/TTS path; rule-based translations are deterministic safety rails before provider calls.
- `backend/public` and `frontend` must stay in sync through `scripts/sync-frontend-to-public.js`.
- Use TDD: failing tests first, then minimal code, then refactor while green.
- Do not touch secrets or Azure app settings.

---

### Task 1: Translation Determinism

**Files:**
- Modify: `backend/services/visitTranslationFallback.js`
- Modify: `backend/server.js`
- Modify: `backend/scripts/test-visit-translation-quality.js`

**Steps:**
- [ ] Add failing quality tests for water request, location/name/eaten phrases, mixed ASR help request, English volunteer line auto-routed to Cantonese, and noisy Cantonese practice request.
- [ ] Run `npm run test:visit-translation-quality` and confirm expected failure.
- [ ] Centralize deterministic translation rules in `visitTranslationFallback.js` and have `server.js` call the service instead of duplicate server-local mappings.
- [ ] Run targeted quality and HTTP routing tests until green.

### Task 2: Translate Layout Isolation

**Files:**
- Modify: `backend/public/index.html`
- Modify: `backend/public/app.js`
- Modify: `backend/public/styles.css`
- Modify: mirrored `frontend/*` files through sync after public changes
- Modify: `backend/scripts/test-visit-layout-contract.js`

**Steps:**
- [ ] Add failing layout contract tests that exactly one default `translate` view is visible, old hero/onboarding/guide are not tagged as V2 translate views, and the practice input dock is not part of Translate view.
- [ ] Add a dedicated visit input strip inside `#visitTranslatePanel` and wire it to `translateVisitText`.
- [ ] Remove `translate` from the practice dock view mapping so it cannot overlap the translator.
- [ ] Run layout contract and V2 translation contract until green.

### Task 3: Regression Gate Restoration

**Files:**
- Modify: `backend/scripts/test-v2-phrasebook-review-contract.js`
- Modify: `scripts/sync-frontend-to-public.js` only if new files need sync coverage

**Steps:**
- [ ] Restore the accidentally emptied phrasebook/review test and add a minimum-size guard.
- [ ] Run `npm run sync:frontend:check`, `npm run test:v2`, and `npm run test:regressions`.
- [ ] Verify browser layout at desktop and mobile with automated checks.
