# Hong Kong Buddy V2 UI/UX Design

## Goal

Build Hong Kong Buddy V2 into a business-ready paid pilot experience where Cantonese learning habit is the primary product path and daily-life or community-visit translation is the secondary tool.

## Product Position

Hong Kong Buddy is not a generic translation demo. It is a student-life Cantonese practice workspace with a reliable visit interpreter attached.

The first successful user experience should be:

1. A learner opens the app and immediately sees what to practise today.
2. The learner can complete one short Cantonese habit loop in under three minutes.
3. If the learner is in a visit or real-life situation, they can switch to translation without losing clarity about speaker, direction, safety, or confidence.
4. The app is honest about voice availability, AI limits, and when staff confirmation is needed.

## Design References

Primary reference: `design-skills/awesome-design-md/references/design-md/intercom/DESIGN.md`

- Use Intercom's product-led support-console clarity: restrained surfaces, clear conversation hierarchy, helpful state labels, modest card radius, and product UI as the protagonist.
- Adapt the warm cream/white surface model into a calm learning workspace. Do not copy Intercom branding, Fin color rules, logo, or exact product surfaces.

Secondary references:

- `apple`: calm premium whitespace, strong focus on the main task, minimal decoration, and reliable touch targets.
- `notion`: structured learning notes, phrasebook organization, small status badges, and sober card geometry.

Avoid:

- Dark-neon provider dashboards for the main learner flow.
- Landing-page hero patterns that delay the actual app.
- Oversized rounded controls that cause text overflow.
- Decorative gradients, blobs, or brand imitation.

## User Priorities

Primary user path: Cantonese learning habit.

- Daily practice continuity matters more than one-off translation.
- The user needs a clear next action, not a menu of everything the app can do.
- Learning mode should highlight one recommended task, pronunciation support, tutor response, and review notes.

Secondary user path: daily-life and visit translation.

- Translation must be fast, legible, and explicit about direction.
- The user must see whether the resident or volunteer is speaking.
- The result must not present a generic fallback as a confident translation.

## Information Architecture

### App Shell

The first screen should be the working product, not a marketing page.

Top-level navigation:

- Today
- Practice
- Translate
- Phrasebook
- Privacy

The header should show:

- Hong Kong Buddy identity.
- Current mode.
- System readiness: backend, voice input, MiniMax TTS.
- Language selector.

The header must not become a dense settings toolbar. Advanced controls stay near the feature they affect.

### Today View

This becomes the default first viewport for V2.

Required content:

- Today's recommended Cantonese task.
- A short streak or habit card.
- Quick Start button for the recommended task.
- Secondary entry to Visit Translation.
- Voice readiness summary.

The Today view should make the user feel, "I know what to do next."

### Practice Workspace

Practice is the primary product surface.

Recommended desktop structure:

- Left panel: today's task, scenario, mode, phrase starters.
- Center panel: conversation transcript and input.
- Right panel: coach notes, corrections, review summary.

Recommended mobile structure:

- Task summary at top.
- Conversation in the middle.
- Input dock at bottom.
- Coach notes as a collapsible section after the latest tutor reply.

Modes:

- Practice mode: default learning loop.
- Teaching mode: correction-heavy.
- Free talk: relaxed conversation.

Mode labels must explain outcomes, not internal implementation names.

### Translation Workspace

Translation is a secondary tool with its own clean console.

Required jobs:

- Resident speaks Cantonese: translate Cantonese to English or Mandarin.
- Volunteer speaks English or Mandarin: translate to polite Cantonese.

Each job must show:

- Speaker role.
- Source language.
- Target language.
- Input method: typing or voice.
- Output confidence/safety state.
- Staff confirmation reminder when relevant.

The hidden select can remain as a compatibility layer, but the user-facing direction control must be card-based and explicit.

## Interaction Model

### Learning Habit Loop

The default V2 loop:

1. User chooses or accepts today's task.
2. App starts a session in practice mode.
3. User types or speaks one line.
4. Tutor responds with Cantonese plus optional English/Mandarin support based on user mode.
5. Coach notes summarize one useful correction or improvement.
6. User can replay audio, slow it down, or save the phrase.

Completion state:

- Show a compact "Today practised" signal after the first successful exchange.
- Do not require account/auth in this V2 phase.
- Persist lightweight habit state in local storage only.

### Translation Loop

The default V2 translation loop:

1. User picks Resident or Volunteer job.
2. User picks target or source language.
3. User types or records the utterance.
4. App calls `/api/visit-translate`.
5. App shows input and output as paired cards.
6. App shows route note if auto-routed.
7. App clearly labels fallback, low-confidence, TTS skipped, or confirmation-required states.

If translation fails:

- Keep the user's input visible.
- Show a human-readable error.
- Offer retry and typing fallback.
- Do not append a generic success-looking translation bubble.

### Voice Input

Voice input must be honest.

States:

- Checking.
- Available.
- Unavailable: typing-first mode.
- Permission blocked.
- Recording.
- Processing.
- Failed with retry.

Rules:

- The microphone must not be clickable until ASR is ready.
- The unavailable state should look disabled, not like the primary action.
- Voice state should be local to the active workspace.
- TTS voice and speed controls should not squeeze the main input field.

### TTS

MiniMax should remain the preferred high-quality voice path.

Rules:

- Show selected voice and speed near replay controls.
- Keep speed presets but make them compact.
- Replay should be disabled or clearly empty when no audio exists.
- If TTS falls back to mock or is skipped, label it clearly.

## Visual System

Canvas:

- Use a warm, restrained app background derived from Intercom's cream/white relationship.
- Main panels should be white or near-white with thin hairline borders.
- Avoid heavy shadows. Use shadows only for the main workspace lift if needed.

Typography:

- Keep system-safe fonts already used by the project.
- Use `Noto Sans HK` for Cantonese-heavy text.
- Use `Inter` for UI labels and English.
- Do not use viewport-width font scaling.
- Letter spacing should be `0` for app text.

Components:

- Buttons: 8px radius for ordinary actions, pill only for compact segmented controls where already useful.
- Cards: 8px to 12px radius.
- Inputs: minimum 44px touch target.
- Badges: small, readable, high-contrast.
- Message bubbles: role, timestamp, and output type must be scannable.

Color roles:

- Primary action: current blue can stay if contrast passes.
- Learning success: green only for complete/ready states.
- Warning: amber for AI/staff confirmation.
- Error: red for failed actions only.
- Disabled: grey with clear disabled cursor and no active shadow.

## Required Phases

### Phase 1: V2 App Shell and Today View

Deliverable:

- A default first viewport focused on the daily Cantonese habit.
- Clear navigation between Today, Practice, Translate, Phrasebook, and Privacy.
- Existing role onboarding no longer blocks the primary app experience.

Tests:

- Static layout contract checks for Today view selectors.
- Language toggle still works.
- Existing visit translation tests still pass.

### Phase 2: Practice Workspace

Deliverable:

- Practice becomes the primary workspace with a clear task, transcript, input, and coach notes.
- Teaching/free-talk naming becomes user-facing and outcome-based.
- Existing `/api/session`, `/api/chat`, `/api/correct`, TTS, and replay paths continue to work.

Tests:

- Session creation from Practice.
- Text send creates user and tutor messages.
- Correct Me requires a user utterance.
- Replay is disabled when no tutor audio exists and enabled after audio is returned.

### Phase 3: Translation Workspace

Deliverable:

- Translation becomes a separate, focused console.
- Resident and Volunteer tasks are explicit.
- Generic fallback and low-confidence states are visually distinct from successful translations.
- Auto-routed direction is visible and understandable.

Tests:

- Existing direction routing test.
- Existing HTTP routing test.
- New UI contract for paired input/output cards.
- Failed `/api/visit-translate` keeps input visible and shows retry.

### Phase 4: Voice and Audio Controls

Deliverable:

- Voice input states are reliable and workspace-specific.
- MiniMax voice selection remains available without crowding the input.
- Speed and replay controls are compact and responsive.

Tests:

- Existing voice-disabled UI test.
- Voice unavailable guard runs before permission request.
- Visit translation input does not overflow at mobile widths.
- Practice input does not overlap transcript or footer.

### Phase 5: Phrasebook and Review

Deliverable:

- Phrasebook supports learning habit and visit translation.
- Saved or selected phrase can start a practice session or be used in translation.
- Review area summarizes latest learning value without creating account complexity.

Tests:

- Selecting a phrase populates the correct input.
- Clear phrase restores empty state.
- Local habit completion state persists after refresh.

### Phase 6: Business-Ready Polish and Verification

Deliverable:

- The app feels like a paid V2 pilot, not a demo.
- Copy uses product language: "practice", "translate", "confirm", "review".
- Privacy and AI limit messages are visible but not disruptive.
- Responsive layouts are verified.

Tests:

- Full regression suite.
- Browser smoke test for Today, Practice, Translate, Phrasebook, Privacy.
- Desktop and mobile viewport screenshot checks.
- Manual one-by-one function checklist.

## Bug-Avoidance Requirements

Every behavior change must follow test-first work:

1. Add or update a focused failing test.
2. Run it and confirm the expected failure.
3. Implement the smallest change.
4. Run the focused test.
5. Run the relevant regression group.

Root-cause rule:

- Do not patch translation or voice symptoms without tracing whether failure begins in UI state, request payload, backend route, provider response, or rendering.

Dirty worktree rule:

- Do not revert existing user or previous generated changes.
- Stage only files changed for the current phase.
- Keep source edits separate from generated deployment artifacts.

## Functional Test Matrix

Baseline:

- App loads.
- `/api/health` renders readiness.
- Language switch updates visible copy.
- Navigation moves between Today, Practice, Translate, Phrasebook, Privacy.

Practice:

- New practice session.
- Free practice text send.
- Teaching correction mode.
- Correct Me empty state.
- Correct Me after a user utterance.
- Tutor audio replay.
- TTS speed presets.
- Voice selection.

Translation:

- Resident Cantonese to English.
- Resident Cantonese to Mandarin.
- Volunteer English to Cantonese.
- Volunteer Mandarin to Cantonese.
- English input auto-routes away from resident direction.
- Generic provider fallback is not shown as confident success.
- Low confidence requires confirmation.
- TTS skipped for non-speakable output is labeled.
- API error keeps input and offers retry.

Voice:

- Voice checking state.
- Voice unavailable typing-first state.
- Permission denied.
- Permission blocked.
- Recording start/stop.
- No audio captured.
- ASR low confidence.
- ASR provider failure.

Layout:

- Desktop 1440px.
- Laptop 1280px.
- Tablet 980px.
- Mobile 390px.
- Input bar never overlaps main content.
- Long Cantonese, Jyutping, and English text wrap cleanly.

## Out Of Scope For This V2 Pass

- User accounts.
- Payments.
- Server-side habit history.
- Admin dashboard.
- New AI providers beyond existing configured providers.
- Replacing the backend architecture.
- Rebranding with copied external brand assets.

## Acceptance Criteria

The work is complete when:

- Cantonese learning habit is the first visible and functional path.
- Visit translation is still available and clearer than V1.
- No existing visit translation regression test is broken.
- New V2 UI contracts cover the primary learning and translation flows.
- Browser verification confirms desktop and mobile layouts do not overlap.
- Voice unavailable, translation fallback, API error, and low-confidence states are visibly distinct.
- The app can be presented as a paid pilot V2 without calling itself a demo.
