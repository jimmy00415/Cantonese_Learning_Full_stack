# PRD: Inclusive Learner Copy, Speakable Cantonese, and Two-Way Visit Translation

**Date:** 2026-06-09  
**Status:** Engineering-ready draft  
**Priority:** P0 for copy and speech bugs; P0/P1 for visit translation UX hardening  
**Prepared for:** Hong Kong Buddy / Cantonese Tutor app team

---

## 1. Summary

Recent user feedback identifies three pilot-blocking issues:

1. The app labels the Chinese-reading Cantonese learner path as region-based learner wording, which excludes Chinese readers who are not from Chinese-reading China.
2. The AI tutor sometimes reads Cantonese romanization tone numbers aloud, e.g. "Nei 5 Hou 2 Maa 1", instead of speaking the Cantonese phrase naturally.
3. In elderly-visit use, users are unsure whether the app supports both directions: English question -> Cantonese/Jyutping/audio, and elder's Cantonese reply -> English meaning.

This PRD turns that feedback into implementation scope. The product should describe learners by language ability and learning need, not nationality or origin. The product should also separate "pronunciation display" from "speakable text": Jyutping tone numbers can be useful on screen, but they must not be sent to TTS as speech text. Visit Translation must be clearly two-way, with a manual direction selector for MVP and optional auto-detection later.

---

## 2. Research Notes

### Jyutping and Tone Numbers

The Linguistic Society of Hong Kong states that Jyutping was designed in 1993 and uses English letters plus numbers. In the Jyutping scheme, tone numbers are written with Arabic numerals. This confirms that tone numbers are legitimate as a written pronunciation guide, but does not mean they should be spoken by TTS.

Engineering implication: keep Jyutping as display metadata, but never pass Jyutping strings as Cantonese TTS text unless the feature is explicitly "read pronunciation guide", and even then suppress or explain tone numbers.

### Speech and Translation Feasibility

The current codebase already has:

- Cantonese ASR/TTS configuration paths in `backend/server.js`.
- `visitTranslationDirections` with `en_to_yue`, `yue_to_en`, `yue_to_zh`, and `zh_to_yue`.
- `/api/visit-translate` returning `translatedText`, `displayText`, `romanization`, `confidence`, `needsConfirmation`, and `ttsAudio`.
- Azure Speech documentation lists Cantonese/Hong Kong speech capabilities, including Cantonese speech translation target code `yue` and Cantonese Traditional `zh-HK` support across related speech features.

Engineering implication: two-way visit translation is not a brand-new product idea. The core route exists, but the UI, copy, state handling, and QA contract must make the capability obvious and reliable.

References:

- Linguistic Society of Hong Kong Jyutping scheme: https://lshk.org/jyutping-scheme/
- Microsoft Azure Speech language support: https://learn.microsoft.com/en-us/azure/ai-services/Speech-Service/language-support

---

## 3. Goals

- Remove visible region-based learner wording wording from the learner path.
- Reframe the first learner card as "Chinese reader / Chinese-literate learner" without implying geography.
- Prevent TTS from reading Jyutping tone digits aloud.
- Make Visit Translation visibly support both:
  - Student asks in English -> app shows Cantonese, Jyutping, and plays Cantonese audio.
  - Elder replies in Cantonese -> app shows English translation for the student.
- Add regression tests and QA cases for the exact user feedback.

---

## 4. Non-Goals

- Do not remove Jyutping tone numbers from all educational display. Tone numbers are valid and useful for learners when clearly labelled.
- Do not replace the entire speech stack.
- Do not promise medical, legal, social-work, or care advice during elderly visits.
- Do not build full automatic diarization or speaker identification in MVP.
- Do not split into separate Chinese-reading / International deployments. Use one inclusive codebase with role-based flows.

---

## 5. Product Principles

1. **Describe ability, not origin.** Use "students who read Chinese" instead of "Chinese-reading students".
2. **Separate display from speech.** Jyutping is visual learning support; Cantonese audio should use Chinese Cantonese text.
3. **Make bidirectionality explicit.** Visit users should know which side is speaking and what language the app will output.
4. **Use human confirmation for risk.** Visit translation must show confidence and ask users to confirm important meaning with staff or volunteers.
5. **Teach without overloading.** Beginners can see Jyutping, but the default spoken output must be natural.

---

## 6. Current Codebase Findings

### Frontend

- Main source files:
  - `frontend/index.html`
  - `frontend/app.js`
  - `frontend/i18n/index.js`
  - `frontend/content/playbooks.js`
- Production static copy:
  - `backend/public/index.html`
  - `backend/public/app.js`
  - `backend/public/i18n/index.js`
  - `backend/public/content/playbooks.js`
- Sync already exists:
  - `scripts/sync-frontend-to-public.js`
  - `npm run sync:frontend`
  - `npm run sync:frontend:check`

### Specific Affected Areas

- `frontend/i18n/index.js` and `backend/public/i18n/index.js` contain:
  - EN: "Best for Chinese-reading students..."
  - zh-TW: "...同學"
  - zh-CN: "...同学"
- `frontend/index.html` and `backend/public/index.html` have fallback English copy with "Chinese-reading".
- `frontend/app.js` uses internal `chinese_reader_learner` mode. This can remain temporarily for backward compatibility, but user-facing copy must change.
- `frontend/app.js` renders `res.romanization` directly below translation output and large text output.
- `backend/server.js` already has `visitTranslationDirections.yue_to_en`, but the UI does not strongly answer the user's two-way translation question.
- `backend/server.js` currently has a language policy that forces main tutor replies to written Cantonese, while English support is placed in Coach Notes / translation surfaces. This must be documented in UI copy so international students know which mode to use.

---

## 7. User Stories

### US1: Chinese Reader Cantonese Learner

As a student who can read Chinese and wants to improve Cantonese, I want the app to show me a Cantonese practice path without assuming I am from Chinese-reading China, so that I feel included.

### US2: International Student Preparing Visit Questions

As an international student, I want to type an English question and receive a Cantonese phrase, Jyutping guide, and Cantonese audio, so that I can ask an elder politely.

### US3: International Student Listening to Elder

As an international student, I want to record or type an elder's Cantonese reply and receive English meaning, so that I can understand the answer.

### US4: Beginner Reading Jyutping

As a beginner, I want to see Jyutping tone numbers on screen when learning pronunciation, but I do not want the AI voice to read "five, two, one" aloud.

### US5: Staff / Volunteer Safety Review

As a staff member, I want the app to warn that AI translation may be wrong and that important meaning should be confirmed with a human, so that the visit remains safe.

---

## 8. Requirements

### P0-R1: Inclusive Copy Replacement

Replace all visible region-based learner wording learner copy in the app.

Recommended copy:

| Locale | Current | Replace with |
|---|---|---|
| en | Best for Chinese-reading students who read Chinese and want pronunciation, particles, and natural phrasing. | Best for students who read Chinese and want better Cantonese pronunciation, particles, and natural phrasing. |
| zh-TW | 適合識中文、想改善廣東話發音、語氣助詞同自然講法嘅同學。 | 適合識中文、想改善廣東話發音、語氣助詞同自然講法嘅同學。 |
| zh-CN | 适合会读中文、想改善粤语发音、语气助词和自然表达的同学。 | 适合会读中文、想改善粤语发音、语气助词和自然表达的同学。 |

Recommended title/key rename:

| Current internal/user-facing concept | Recommended user-facing concept |
|---|---|
| Chinese-reading learner | Chinese-reading learner |
| `chinese_reader_learner` | Keep as compatibility alias; add `chinese_reader_learner` in code when safe |
| CN badge | `中文` or `ZH` if space allows |

Acceptance criteria:

- `rg -n -i "region-based|中文閱讀|中文阅读" frontend backend/public` returns no user-facing copy occurrences.
- If internal enum `chinese_reader_learner` remains, it is documented as legacy and not shown in UI.
- Role card copy no longer implies nationality, region, or origin.

### P0-R2: App Subtitle Inclusivity Pass

Review the top subtitle because current English copy says "Campus Cantonese practice for international students". This is acceptable only if the app is explicitly marketed to international students. If the app also serves Chinese-reading non-Cantonese speakers, update to:

- EN: "Campus Cantonese practice for HKBU students"
- zh-TW: "HKBU 同學廣東話實戰練習"
- zh-CN: "HKBU 同学粤语实战练习"

Acceptance criteria:

- Header/subtitle does not contradict the inclusive learner role card.
- International Student remains a dedicated path, but the whole app is not framed as excluding other non-Cantonese learners.

### P0-R3: Speakable Text Must Be Separate from Romanization

Introduce a translation output model that separates display text, pronunciation guide, and TTS text.

Recommended response model:

```json
{
  "sourceText": "Hello, how are you?",
  "sourceLanguage": "en",
  "targetLanguage": "yue-Hant-HK",
  "displayText": "你好嗎？",
  "speakableText": "你好嗎？",
  "romanization": {
    "scheme": "jyutping",
    "text": "nei5 hou2 maa1?",
    "toneNumbers": true
  },
  "englishMeaning": "Hello, how are you?",
  "confidence": 0.86,
  "needsConfirmation": false
}
```

Rules:

- TTS must use `speakableText`.
- UI may show `romanization.text`.
- TTS must not use `romanization.text` for Cantonese audio.
- If `speakableText` is missing, backend should fall back to `displayText` only when target language is not a romanization scheme.
- If `displayText` appears to be Jyutping or contains many tone-number patterns, block Cantonese TTS and show a warning.

Acceptance criteria:

- Input: "Hello, how are you?" with direction English -> Cantonese.
- Output display includes "你好嗎？" and optionally "nei5 hou2 maa1?"
- Audio says natural Cantonese equivalent of "你好嗎？"
- Audio does not say "nei five hou two maa one" or "Nei 5 Hou 2 Maa 1".

### P0-R4: Jyutping Display Defaults and Labels

Update UI labels so users understand romanization is a pronunciation guide, not Mandarin pinyin.

Required labels:

- EN: "Jyutping pronunciation guide"
- zh-TW: "粵拼發音提示"
- zh-CN: "粤拼发音提示"

Optional helper:

- EN: "Numbers show Cantonese tones and are for reading only."
- zh-TW: "數字代表廣東話聲調，只作閱讀提示。"
- zh-CN: "数字代表粤语声调，只作阅读提示。"

Acceptance criteria:

- Romanization text is visually secondary to the Cantonese phrase.
- Tone numbers are not inserted with spaces between syllable and number. Use `nei5 hou2 maa1?`, not `Nei 5 Hou 2 Maa 1`.
- A future toggle can hide/show Jyutping, but MVP can show it by default in learner and visit modes.

### P0-R5: Visit Translation Must Be Clearly Two-Way

Replace the current single "Direction" dropdown emphasis with a two-party visit UI.

MVP UI model:

- Primary segmented control:
  - "I speak English" -> English to Cantonese
  - "Resident speaks Cantonese" -> Cantonese to English
- Secondary directions:
  - Cantonese -> Chinese
  - Chinese -> Cantonese

For each mode:

| Speaker | Input | Output | TTS |
|---|---|---|---|
| Student | English | Cantonese + Jyutping + meaning | Play Cantonese `speakableText` |
| Resident | Cantonese | English meaning + source transcript | English TTS optional, off by default |
| Resident | Cantonese | Chinese written meaning | No romanization by default |
| Student / staff | Chinese | Cantonese + Jyutping | Play Cantonese `speakableText` |

Acceptance criteria:

- International student can answer the user's question confidently: yes, elder Cantonese can be translated to English in Visit Translation mode.
- The UI shows a visible "Resident speaks Cantonese -> English" path.
- Direction remains visible in transcript entries.
- Manual typed fallback works without microphone permission.

### P0-R6: Visit Translation Transcript Must Preserve Both Sides

Each visit turn should render:

- Speaker label: Student / Resident / AI translation.
- Source text.
- Target translation.
- Confidence/confirmation warning when needed.
- Play button only for the relevant speakable output.

Acceptance criteria:

- A Cantonese source line translated to English shows the original Cantonese transcript and English meaning.
- A Cantonese source line does not show irrelevant Jyutping unless user expands pronunciation details.
- Low-confidence output says: "AI may be inaccurate. Confirm important meaning with a volunteer or staff member."

### P0-R7: International Mode Guidance Clarification

Clarify the distinction between:

- **Cantonese Practice / Tutor mode:** teaches Cantonese and may keep main tutor voice in Cantonese, with English Coach Notes.
- **Visit Translation mode:** translates between the student and resident.

Required microcopy:

- EN: "For live visit conversation, use Visit Translation. Cantonese Practice is for learning and coaching."
- zh-TW: "探訪即場溝通請用「探訪翻譯」；廣東話練習模式主要用嚟學習同糾正。"
- zh-CN: "探访现场沟通请用“探访翻译”；粤语练习模式主要用于学习和纠正。"

Acceptance criteria:

- International users are not left wondering whether the tutor can translate an elder's reply.
- The role panel includes "Translate a Cantonese reply into English" as an action or hint.

### P1-R8: Auto Direction Detection

After MVP manual direction is stable, consider auto-detect:

- If transcript contains mostly CJK/Cantonese, suggest Cantonese -> English.
- If transcript contains mostly English, suggest English -> Cantonese.
- Require manual confirmation before sending if confidence is low.

Acceptance criteria:

- Auto detection never silently flips direction during a visit.
- User can override direction quickly.

---

## 9. API Contract

### POST `/api/visit-translate`

Backward-compatible request:

```json
{
  "sessionId": "abc123",
  "sourceText": "Hello, how are you?",
  "direction": "en_to_yue",
  "inputType": "text",
  "userMode": "visit_translation"
}
```

Recommended enhanced request:

```json
{
  "sessionId": "abc123",
  "sourceText": "Hello, how are you?",
  "direction": "en_to_yue",
  "sourceLanguage": "en",
  "targetLanguage": "yue-Hant-HK",
  "speakerRole": "student",
  "inputType": "text",
  "outputOptions": {
    "includeRomanization": true,
    "romanizationScheme": "jyutping",
    "generateTts": true
  }
}
```

Recommended enhanced response:

```json
{
  "sourceText": "Hello, how are you?",
  "sourceLanguage": "en",
  "targetLanguage": "yue-Hant-HK",
  "translatedText": "你好嗎？",
  "displayText": "你好嗎？",
  "speakableText": "你好嗎？",
  "romanization": {
    "scheme": "jyutping",
    "text": "nei5 hou2 maa1?",
    "toneNumbers": true
  },
  "confidence": 0.86,
  "needsConfirmation": false,
  "ttsAudio": "data:audio/mpeg;base64,...",
  "ttsTextUsed": "你好嗎？",
  "provider": "minimax",
  "direction": "en_to_yue"
}
```

Backend safeguards:

- If `targetLanguage` is Cantonese and `ttsTextUsed` matches romanization/tone-number pattern, return `ttsAudio: null`, set `needsConfirmation: true`, and include `warningCode: "romanization_not_speakable"`.
- If direction is `yue_to_en`, `romanization` should be empty by default and `ttsAudio` should be optional.

---

## 10. Engineering Tasks

### Task 1: Inclusive Copy Update

Files:

- `frontend/i18n/index.js`
- `frontend/index.html`
- Run `npm run sync:frontend` to update `backend/public/*`.

Steps:

1. Replace visible `region-based`, `中文閱讀`, `中文阅读` copy.
2. Add comments around `chinese_reader_learner` if retained as legacy localStorage compatibility.
3. Optionally introduce `chinese_reader_learner` alias and migrate saved localStorage.
4. Run sync check.

Validation:

```powershell
cd D:\VS_PROJECT\HongKong_Buddy\Cantonese_Tutor_Full_Stack
rg -n -i "region-based|中文閱讀|中文阅读" frontend backend/public
npm run sync:frontend:check
```

### Task 2: Pronunciation Display / TTS Separation

Files:

- `backend/server.js`
- `frontend/app.js`
- `frontend/content/playbooks.js` if phrase data structure is extended
- `backend/eval/reliability-cases.json`

Steps:

1. Add `speakableText` to visit translation generation.
2. Update `translateForVisit()` prompt to return `speakableText`.
3. Update `parseVisitTranslation()` to parse object romanization and fallback old string shape.
4. Update `synthesizeVisitTranslationAudio()` caller to pass `speakableText`.
5. Add regex guard against Jyutping/tone-number TTS.
6. Update frontend rendering to show `romanization.text` with "Jyutping pronunciation guide".

Suggested guard heuristic:

```js
const JYUTPING_TONE_PATTERN = /\b[a-z]{1,8}[1-6]\b/i;
const MANY_ROMANIZED_SYLLABLES = /(?:\b[a-z]{1,8}[1-6]\b[\s,?.]*){2,}/i;
```

Acceptance test:

- Mock/LLM returns `romanization: "nei5 hou2 maa1?"`.
- TTS must use `speakableText: "你好嗎？"` only.

### Task 3: Two-Way Visit Translation UX

Files:

- `frontend/index.html`
- `frontend/app.js`
- `frontend/styles.css`
- `frontend/i18n/index.js`
- Run `npm run sync:frontend`

Steps:

1. Replace or augment dropdown with two large direction buttons.
2. Keep advanced dropdown for Cantonese <-> Chinese if needed.
3. Add role-specific labels:
   - Student speaks
   - Resident speaks
4. Add output states for English result and Cantonese result.
5. Add transcript entries with direction and speaker role.
6. Add empty state:
   - "Choose who is speaking, then type or hold to speak."
7. Add success state:
   - "Translated. Confirm important meaning with staff."

### Task 4: User Education Copy

Files:

- `frontend/i18n/index.js`
- Guide/playbook dialog copy

Steps:

1. Add microcopy explaining the difference between Practice and Visit Translation.
2. Add FAQ line:
   - EN: "Can it translate an elder's Cantonese reply into English? Yes. Choose Resident speaks Cantonese in Visit Translation."
   - zh-TW: "長者用廣東話回答，可以轉成英文嗎？可以。喺探訪翻譯揀「長者講廣東話」。"
   - zh-CN: "长者用粤语回答，可以转成英文吗？可以。在探访翻译选择“长者讲粤语”。"

### Task 5: QA / Regression Cases

Files:

- `backend/eval/reliability-cases.json`
- Add frontend manual QA checklist if no automated frontend tests exist.

Add cases:

```json
{
  "id": "inclusive-copy-no-region-based",
  "type": "copy",
  "input": "role onboarding",
  "expected": "No visible region-based learner wording wording in learner path."
}
```

```json
{
  "id": "tts-does-not-read-jyutping-tone-numbers",
  "type": "tts_safety",
  "input": "English -> Cantonese output with romanization nei5 hou2 maa1?",
  "expected": "TTS uses Cantonese Chinese speakableText, not romanization."
}
```

```json
{
  "id": "visit-resident-cantonese-to-english",
  "type": "visit_translation",
  "input": "Resident says Cantonese: 你好，好高興見到你。",
  "expected": "Direction yue_to_en returns English meaning and no irrelevant Jyutping by default."
}
```

---

## 11. UX Copy Inventory

### Role Card

EN:

- Title: "I want to practise Cantonese"
- Body: "Best for students who read Chinese and want better Cantonese pronunciation, particles, and natural phrasing."

zh-TW:

- Title: "我想練習廣東話"
- Body: "適合識中文、想改善廣東話發音、語氣助詞同自然講法嘅同學。"

zh-CN:

- Title: "我想练习粤语"
- Body: "适合会读中文、想改善粤语发音、语气助词和自然表达的同学。"

### Visit Translation Direction Buttons

EN:

- "I speak English"
- "Resident speaks Cantonese"
- "Show Cantonese to resident"
- "Translate reply to English"

zh-TW:

- "我用英文講"
- "長者講廣東話"
- "顯示廣東話俾長者"
- "將回答譯成英文"

zh-CN:

- "我用英文说"
- "长者讲粤语"
- "显示粤语给长者"
- "把回答译成英文"

### Jyutping Label

EN:

- "Jyutping pronunciation guide"
- "Numbers show Cantonese tones and are for reading only."

zh-TW:

- "粵拼發音提示"
- "數字代表廣東話聲調，只作閱讀提示。"

zh-CN:

- "粤拼发音提示"
- "数字代表粤语声调，只作阅读提示。"

---

## 12. Manual QA Script

### QA1: Inclusive Copy

1. Clear local storage.
2. Load app in English.
3. Confirm first role card says "students who read Chinese", not "Chinese-reading students".
4. Switch to Traditional Chinese.
5. Confirm no "中文閱讀".
6. Switch to Simplified Chinese.
7. Confirm no "中文阅读".

### QA2: English -> Cantonese Visit Translation

1. Select Visit Translation.
2. Choose "I speak English".
3. Enter: "Hello, how are you?"
4. Confirm output shows Cantonese phrase and Jyutping.
5. Play audio.
6. Confirm audio does not read tone numbers.

### QA3: Cantonese -> English Visit Translation

1. Select "Resident speaks Cantonese".
2. Enter or speak: "你好，好高興見到你。"
3. Confirm output is English meaning.
4. Confirm original Cantonese transcript is visible.
5. Confirm confirmation warning appears if provider is mock or confidence is low.

### QA4: Practice vs Translation Clarity

1. Select International Student mode.
2. Confirm role panel explains Visit Translation for live conversations.
3. Ask a normal tutor question in English.
4. Confirm English Coach Notes or translation support is available.
5. Confirm the app does not imply the normal tutor chat is the only way to translate elder replies.

---

## 13. Release Gate

Do not release to activity users until:

- Visible app copy contains no region-based learner wording learner wording.
- The app can demonstrate English -> Cantonese visit translation with Cantonese audio.
- The app can demonstrate Cantonese -> English visit translation.
- Tone-number Jyutping is never used as Cantonese TTS input.
- Visit Translation has manual text fallback.
- Low-confidence/mock output shows confirmation warning.
- `npm run sync:frontend:check` passes before deployment.

---

## 14. Open Questions

1. Should the app's top-level positioning be HKBU-student-wide or international-student-first?
2. Should the internal mode enum be migrated from `chinese_reader_learner` to `chinese_reader_learner` now, or kept as a compatibility alias until after pilot?
3. Should English TTS be enabled for Cantonese -> English outputs, or should English translation remain text-only during MVP to reduce noise in visits?
4. Should Jyutping be shown by default in Visit Translation, or only for English -> Cantonese and Chinese -> Cantonese directions?
5. Who validates Cantonese phrasing for elderly-visit politeness before pilot: local volunteer, language teacher, or activity staff?

---

## 15. Recommended Implementation Order

1. P0-R1 copy replacement.
2. P0-R3 speakable text / romanization separation.
3. P0-R5 two-way Visit Translation UI.
4. P0-R6 visit transcript clarity.
5. P0-R7 mode guidance and FAQ.
6. Regression cases and manual QA checklist.

This order fixes the reputational/inclusion issue first, then the most visible speech bug, then the elderly-visit capability question.
