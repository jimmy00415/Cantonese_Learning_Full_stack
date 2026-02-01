# Cantonese Learning Bot – Software Engineering Iteration Plan (SE_Iteration v1.0)

**Version:** 1.0  
**Last Updated:** February 1, 2026  
**Authors:** PM & SE Technical Review Board  
**Reference:** PRD_Iteration.md v2.0

---

## Executive Summary

This document translates the PRD v2.0 requirements into a concrete, prioritized software engineering implementation plan. After deep analysis and internal PM/SE debate, we have structured the work into **4 Phases** with clear dependencies, effort estimates, and acceptance criteria.

### Key Debate Conclusions

| Topic | PM Perspective | SE Perspective | Resolution |
|-------|---------------|----------------|------------|
| **Priority: Features vs Stability** | New features drive user growth | Stability bugs destroy retention | ✅ **Stability first** - P0 bugs before new features |
| **Speech SDK: Self-host vs CDN** | CDN reduces maintenance | CDN blocking kills core feature | ✅ **Self-host primary**, CDN fallback |
| **Mode System: Separate routes vs Flag** | Separate routes clearer | Single codebase easier to maintain | ✅ **Single route with mode flag** in session |
| **Cultural DB: Embedded vs External** | External enables live updates | External adds latency & complexity | ✅ **Embedded JSON** with hot-reload capability |
| **TTS Speed: Slider vs Presets** | Slider gives flexibility | Too many options confuse users | ✅ **Slider with smart presets** (0.8, 1.0, 1.2, 1.5) |

---

## Current State Analysis

### ✅ What's Working
- Azure OpenAI LLM integration (gpt-4o deployment)
- Azure TTS (HiuMaanNeural voice) - audio playback confirmed
- Backend deployed on Azure App Service
- Frontend on GitHub Pages with HTTPS
- Session management with conversation history
- Basic scenario selection

### ⚠️ Known Issues (Must Fix First)
1. **Speech SDK CDN Blocking** - Some users can't load SDK from jsdelivr
2. **SpeechRecognizer "mergeTo" undefined** - SDK API usage incorrect
3. **MediaRecorder WebM format** - Azure ASR prefers WAV/OGG
4. **No interrupt mechanism** - Users can't stop AI speech
5. **No mode system** - Single interaction style only

### 🚫 Missing from PRD Requirements
- Teaching Mode vs Free Talk Mode toggle
- Cultural slang/context database
- "Correct Me" on-demand feedback command
- Pause handling improvements (>2s threshold)
- UI language toggle (Traditional/Simplified/English)
- Fine-grained TTS speed control
- Recording countdown timer

---

## Phase Overview

| Phase | Focus | Duration | Dependencies | Status |
|-------|-------|----------|--------------|--------|
| **P0** | Critical Stability Fixes | 1 week | None | ✅ **COMPLETED** |
| **P1** | Core Experience (Mode System) | 2 weeks | P0 complete | 🟡 Ready |
| **P2** | Intelligence Layer (Cultural Engine + Feedback) | 2 weeks | P1 complete | ⚪ Waiting |
| **P3** | Polish & Optimization | 1 week | P2 complete | ⚪ Waiting |

**Total Estimated Duration:** 6 weeks

---

## Phase 0: Critical Stability Fixes (P0)

**Goal:** Eliminate all blocking bugs that prevent core functionality

### P0-1: Self-Host Speech SDK Bundle
**Priority:** 🔴 CRITICAL  
**Effort:** 4 hours  
**Owner:** Frontend  

**Problem:** Speech SDK from jsdelivr CDN is blocked for some users, causing complete ASR failure.

**Implementation:**
```
Tasks:
├── Download microsoft.cognitiveservices.speech.sdk.bundle-min.js
├── Place in frontend/lib/speech-sdk/
├── Update index.html to load local bundle first
├── Keep CDN as fallback (aka.ms, unpkg)
└── Add version tracking for future updates
```

**Files to Modify:**
- `frontend/index.html` - Update script loading order
- `frontend/lib/speech-sdk/` - New directory with SDK bundle

**Acceptance Criteria:**
- [ ] SDK loads successfully even when CDN blocked
- [ ] Console shows "Speech SDK loaded from: local"
- [ ] Fallback mechanism still works if local file missing

---

### P0-2: Fix SpeechRecognizer Creation Error
**Priority:** 🔴 CRITICAL  
**Effort:** 4 hours  
**Owner:** Frontend  

**Problem:** `mergeTo` undefined error when creating SpeechRecognizer with AutoDetectSourceLanguageConfig.

**Root Cause Analysis:**
```javascript
// WRONG: Passing config object directly
const autoDetectConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(["zh-CN", "yue-CN"]);
const recognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechConfig, autoDetectConfig, audioConfig);

// RIGHT: Use proper constructor
const recognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechConfig, audioConfig);
// OR for language detection:
const recognizer = new SpeechSDK.SpeechRecognizer(speechConfig, audioConfig);
recognizer.properties.setProperty(
  SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode,
  "AtStart"
);
```

**Implementation:**
```
Tasks:
├── Research correct Speech SDK API for Language ID
├── Update initSpeechRecognizer() function
├── Add proper error handling for SDK initialization
├── Test with both zh-CN and yue-CN inputs
└── Add fallback to simple recognizer if Language ID fails
```

**Files to Modify:**
- `frontend/app.js` - `initSpeechRecognizer()` function (~line 600-700)

**Acceptance Criteria:**
- [ ] SpeechRecognizer creates without errors
- [ ] Language detection works for Mandarin and Cantonese
- [ ] Graceful fallback if Language ID not supported

---

### P0-3: Implement Audio Interrupt Mechanism
**Priority:** 🟠 HIGH  
**Effort:** 3 hours  
**Owner:** Frontend  

**Problem:** Users cannot stop AI speech playback, must wait for completion.

**Implementation:**
```javascript
// Add interrupt capability to holdToSpeak button
holdBtn.addEventListener('mousedown', () => {
  // If audio is playing, stop it first
  if (currentAudio && !currentAudio.paused) {
    stopAudio();
    setNotice('已停止播放，請開始說話', 'info');
  }
  handleRecordStart();
});

// Also add dedicated stop button
const stopSpeakingBtn = document.createElement('button');
stopSpeakingBtn.id = 'stopSpeaking';
stopSpeakingBtn.textContent = '停止播放';
stopSpeakingBtn.addEventListener('click', stopAudio);
```

**Files to Modify:**
- `frontend/app.js` - Add interrupt logic to `handleRecordStart()`
- `frontend/index.html` - Add stop button to controls
- `frontend/styles.css` - Style stop button

**Acceptance Criteria:**
- [ ] Clicking mic button during playback stops audio
- [ ] "停止播放" button visible during speaking state
- [ ] State transitions correctly after interrupt

---

### P0-4: Extend Pause Threshold for Speech Input
**Priority:** 🟠 HIGH  
**Effort:** 2 hours  
**Owner:** Frontend + Backend  

**Problem:** System cuts off users who pause to think mid-sentence (current threshold too short).

**Implementation:**
```javascript
// Frontend: Update Speech SDK recognizer config
speechConfig.setProperty(
  SpeechSDK.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
  "3000"  // 3 seconds instead of default ~1s
);

// Add visual indicator during pause
let pauseTimer = null;
recognizer.recognizing = (s, e) => {
  clearTimeout(pauseTimer);
  pauseTimer = setTimeout(() => {
    setNotice('唔緊要，慢慢講...', 'info');
  }, 2000);
};
```

**Files to Modify:**
- `frontend/app.js` - Speech recognizer configuration
- `frontend/index.html` - Add pause indicator element

**Acceptance Criteria:**
- [ ] System waits 3 seconds of silence before finalizing
- [ ] Encouraging message appears after 2s pause
- [ ] Full sentences captured even with mid-sentence pauses

---

## Phase 1: Core Experience - Dual Mode System (P1)

**Goal:** Implement Teaching Mode and Free Talk Mode with distinct behaviors

### P1-1: Mode System Architecture
**Priority:** 🟠 HIGH  
**Effort:** 8 hours  
**Owner:** Full-Stack  

**Design Decision:** Single API endpoint with `mode` parameter, not separate routes.

**Data Model:**
```javascript
// Session now includes mode
const session = {
  id: 'uuid',
  mode: 'teaching' | 'freeChat',  // default: 'freeChat'
  history: [],
  createdAt: timestamp,
  settings: {
    language: 'zh-TW' | 'zh-CN' | 'en',
    ttsSpeed: 1.0,
    pauseThreshold: 3000
  }
};
```

**Backend Changes:**
```javascript
// POST /api/session - Add mode parameter
app.post('/api/session', (req, res) => {
  const { mode = 'freeChat' } = req.body;
  const sessionId = uuidv4();
  conversations.set(sessionId, {
    history: [],
    mode,
    settings: { language: 'zh-TW', ttsSpeed: 1.0 }
  });
  res.json({ sessionId, mode });
});

// POST /api/mode - Switch mode mid-session
app.post('/api/mode', (req, res) => {
  const { sessionId, mode } = req.body;
  const session = conversations.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.mode = mode;
  res.json({ success: true, mode });
});
```

**Files to Modify:**
- `backend/server.js` - Add mode to session, update generateAIResponse
- `frontend/app.js` - Add mode state, mode toggle handler
- `frontend/index.html` - Add mode toggle UI

**Acceptance Criteria:**
- [ ] Mode persists across conversation turns
- [ ] Mode switch updates AI behavior immediately
- [ ] UI clearly indicates current mode

---

### P1-2: Teaching Mode LLM Prompt Engineering
**Priority:** 🟠 HIGH  
**Effort:** 6 hours  
**Owner:** Backend  

**System Prompt for Teaching Mode:**
```javascript
const teachingModePrompt = `你係一個嚴謹但友善嘅廣東話老師。你嘅工作係幫學生改善廣東話。

## 指引：
1. **必須糾正錯誤**：每當學生有發音、文法、用詞錯誤，一定要指出並解釋
2. **提供正確示範**：講出正確嘅講法，用括號標註語調
3. **語氣專業但鼓勵**：像老師咁教導，但要有耐心
4. **使用繁體中文**書寫
5. **保持簡潔**：糾正後繼續對話，回應1-3句

## 糾正格式：
「[學生講嘅話]」→ 應該講「[正確講法]」
[簡短解釋原因]
[繼續對話]

## 場景：${scenario || '日常對話'}`;
```

**Files to Modify:**
- `backend/server.js` - New `getSystemPrompt(mode, scenario)` function

---

### P1-3: Free Talk Mode LLM Prompt Engineering
**Priority:** 🟠 HIGH  
**Effort:** 4 hours  
**Owner:** Backend  

**System Prompt for Free Talk Mode:**
```javascript
const freeTalkModePrompt = `你係一個好傾得嘅香港朋友，鍾意同人聊天。

## 指引：
1. **唔好過份糾正**：除非聽唔明，否則唔使指出小錯誤
2. **講地道廣東話**：用俗語、潮語，講嘢自然啲
3. **保持輕鬆**：像朋友咁傾計，可以講笑
4. **推動對話**：問問題，分享睇法
5. **用繁體中文**書寫

## 場景：${scenario || '自由傾計'}`;
```

---

### P1-4: Mode Toggle UI Component
**Priority:** 🟡 MEDIUM  
**Effort:** 4 hours  
**Owner:** Frontend  

**UI Design:**
```html
<div class="mode-toggle" role="tablist">
  <button role="tab" class="mode-btn active" data-mode="freeChat" aria-selected="true">
    <span class="icon">💬</span>
    <span class="label">Free Talk</span>
    <span class="desc">輕鬆傾計</span>
  </button>
  <button role="tab" class="mode-btn" data-mode="teaching" aria-selected="false">
    <span class="icon">📚</span>
    <span class="label">Teaching</span>
    <span class="desc">認真學習</span>
  </button>
</div>
```

**Files to Modify:**
- `frontend/index.html` - Add mode toggle component
- `frontend/styles.css` - Mode toggle styles
- `frontend/app.js` - Mode switch handler

---

## Phase 2: Intelligence Layer (P2)

### P2-1: Cultural Context Database
**Priority:** 🟡 MEDIUM  
**Effort:** 12 hours  
**Owner:** Full-Stack  

**Database Structure:**
```javascript
// backend/data/cantonese-culture.json
{
  "slang": [
    {
      "term": "痴线",
      "pinyin": "ci1 sin3",
      "meaning": "瘋狂/離譜",
      "context": "朋友間非正式用語，對長輩不禮貌",
      "examples": ["你痴线㗎！", "呢個價錢痴线嘅！"],
      "politeAlternative": "太誇張了",
      "tags": ["informal", "exclamation"]
    },
    {
      "term": "靚仔",
      "pinyin": "leng3 zai2", 
      "meaning": "1) 帥哥 2) 茶餐廳暗語：白飯",
      "context": "茶餐廳點餐：「要一碗靚仔」= 要一碗白飯",
      "examples": ["靚仔，埋單！", "一碗靚仔一杯凍檸茶"],
      "tags": ["cafe-slang", "dual-meaning"]
    }
    // ... 200+ entries
  ],
  "codeSwitch": [
    {
      "pattern": "library",
      "cantonese": "圖書館",
      "context": "學生常用中英混合",
      "example": "我今晚要去library温书"
    }
    // ... common code-switch patterns
  ],
  "idioms": [...],
  "internetSlang": [...]
}
```

**Implementation:**
```javascript
// backend/services/culturalContext.js
import cultureData from '../data/cantonese-culture.json';

export function findSlang(text) {
  return cultureData.slang.filter(s => text.includes(s.term));
}

export function explainTerm(term) {
  const entry = cultureData.slang.find(s => s.term === term);
  if (!entry) return null;
  return `「${entry.term}」(${entry.pinyin}) 嘅意思係：${entry.meaning}。${entry.context}。比較禮貌嘅講法：「${entry.politeAlternative}」`;
}
```

**Files to Create:**
- `backend/data/cantonese-culture.json` - Cultural database
- `backend/services/culturalContext.js` - Query service

**Files to Modify:**
- `backend/server.js` - Integrate cultural context into LLM prompts

---

### P2-2: "Correct Me" On-Demand Feedback
**Priority:** 🟡 MEDIUM  
**Effort:** 8 hours  
**Owner:** Full-Stack  

**Voice Command Detection:**
```javascript
// Detect correction request phrases
const correctionTriggers = [
  '幫我糾正', '帮我纠正', 'correct me', '糾正我',
  '我講得啱唔啱', '我说得对不对', '有冇錯'
];

function isCorrectionRequest(text) {
  return correctionTriggers.some(t => text.toLowerCase().includes(t.toLowerCase()));
}
```

**Backend Correction Endpoint:**
```javascript
app.post('/api/correct', async (req, res) => {
  const { sessionId, utterance } = req.body;
  
  const correctionPrompt = `
作為廣東話老師，分析以下句子：「${utterance}」

請提供：
1. 發音評估（如果有明顯錯誤）
2. 文法檢查
3. 用詞建議（有冇更地道嘅講法）
4. 正確版本

格式：
📝 你講：[原句]
✅ 建議：[改正版本]
💡 解釋：[簡短說明]
`;

  const correction = await generateAIResponse(correctionPrompt, '糾正模式', []);
  res.json({ correction });
});
```

**UI Button:**
```html
<button id="correctMeBtn" class="action-btn ghost" disabled>
  <span class="icon">✏️</span> 幫我糾正
</button>
```

**Files to Modify:**
- `backend/server.js` - Add `/api/correct` endpoint
- `frontend/app.js` - Add correction request handler
- `frontend/index.html` - Add "Correct Me" button

---

### P2-3: Colloquial Reformulation Suggestions
**Priority:** 🟡 MEDIUM  
**Effort:** 6 hours  
**Owner:** Backend  

**Logic:** Detect formal/written Chinese and suggest Cantonese equivalents.

```javascript
// backend/services/colloquialSuggestions.js
const formalToColloquial = {
  '非常': '好/超級',
  '因為': '因為/因住',
  '如果': '如果/假如',
  '請問': '唔該問下',
  '可以嗎': '得唔得/可唔可以',
  '謝謝': '唔該/多謝',
  '再見': '拜拜/再見啦',
  '吃飯': '食飯',
  '說話': '講嘢',
  '知道': '知/識',
  // ... 50+ mappings
};

export function suggestColloquial(text) {
  const suggestions = [];
  for (const [formal, colloquial] of Object.entries(formalToColloquial)) {
    if (text.includes(formal)) {
      suggestions.push({
        original: formal,
        suggested: colloquial,
        reason: `「${formal}」係書面語，口語多數講「${colloquial}」`
      });
    }
  }
  return suggestions;
}
```

---

## Phase 3: UI/UX Polish (P3)

### P3-1: Multi-Language Interface Toggle
**Priority:** 🟡 MEDIUM  
**Effort:** 8 hours  
**Owner:** Frontend  

**Implementation:**
```javascript
// frontend/i18n/index.js
export const locales = {
  'zh-TW': {
    appTitle: '廣東話對話導師',
    holdToSpeak: '按住說話',
    processing: '處理中...',
    modes: {
      freeChat: '輕鬆傾計',
      teaching: '認真學習'
    }
    // ...
  },
  'zh-CN': {
    appTitle: '粤语对话导师',
    holdToSpeak: '按住说话',
    processing: '处理中...',
    // ...
  },
  'en': {
    appTitle: 'Cantonese Conversation Tutor',
    holdToSpeak: 'Hold to Speak',
    processing: 'Processing...',
    // ...
  }
};

export function t(key) {
  const lang = localStorage.getItem('uiLang') || 'zh-TW';
  return key.split('.').reduce((o, k) => o?.[k], locales[lang]) || key;
}
```

**Settings UI:**
```html
<div class="setting-row">
  <label for="uiLang">界面語言</label>
  <select id="uiLang">
    <option value="zh-TW">繁體中文</option>
    <option value="zh-CN">简体中文</option>
    <option value="en">English</option>
  </select>
</div>
```

---

### P3-2: Fine-Grained TTS Speed Slider
**Priority:** 🟢 LOW  
**Effort:** 3 hours  
**Owner:** Frontend  

**Implementation:**
```html
<div class="speed-control">
  <label for="ttsSpeed">語速</label>
  <input type="range" id="ttsSpeed" min="0.5" max="1.5" step="0.05" value="1.0">
  <span id="ttsSpeedValue">1.00×</span>
  <div class="speed-presets">
    <button data-speed="0.8">慢</button>
    <button data-speed="1.0" class="active">正常</button>
    <button data-speed="1.2">快</button>
  </div>
</div>
```

```javascript
// Sync slider with presets
ttsSpeedSlider.addEventListener('input', (e) => {
  const speed = parseFloat(e.target.value);
  ttsSpeedValue.textContent = `${speed.toFixed(2)}×`;
  localStorage.setItem('ttsSpeed', speed);
  // Update preset buttons
  presetBtns.forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.speed) === speed);
  });
});
```

---

### P3-3: Recording Countdown Timer
**Priority:** 🟢 LOW  
**Effort:** 4 hours  
**Owner:** Frontend  

**Implementation:**
```html
<div class="recording-indicator" id="recordingIndicator" hidden>
  <svg class="countdown-ring" viewBox="0 0 36 36">
    <circle class="ring-bg" cx="18" cy="18" r="15.9" />
    <circle class="ring-progress" cx="18" cy="18" r="15.9" 
            stroke-dasharray="100, 100" stroke-dashoffset="0" />
  </svg>
  <span class="time-remaining">60s</span>
</div>
```

```javascript
const MAX_RECORDING_TIME = 60; // seconds

function startRecordingTimer() {
  let remaining = MAX_RECORDING_TIME;
  recordingIndicator.hidden = false;
  
  const interval = setInterval(() => {
    remaining--;
    timeRemaining.textContent = `${remaining}s`;
    const offset = 100 - (remaining / MAX_RECORDING_TIME * 100);
    ringProgress.style.strokeDashoffset = offset;
    
    if (remaining <= 0) {
      clearInterval(interval);
      handleRecordStop();
    }
  }, 1000);
  
  return interval;
}
```

---

### P3-4: TTS Consistency Validation
**Priority:** 🟢 LOW  
**Effort:** 4 hours  
**Owner:** Backend  

**Problem:** Same word pronounced differently in different contexts.

**Solution:** Use SSML phoneme tags for known problematic words.

```javascript
// backend/services/ttsNormalization.js
const phonemeOverrides = {
  '咖喱': '<phoneme alphabet="x-microsoft-ups" ph="S gaa1 lei1">咖喱</phoneme>',
  '大廈': '<phoneme alphabet="x-microsoft-ups" ph="S daai6 haa5">大廈</phoneme>',
  // ... known problematic words
};

export function normalizeForTTS(text) {
  let normalized = text;
  for (const [word, phoneme] of Object.entries(phonemeOverrides)) {
    normalized = normalized.replace(new RegExp(word, 'g'), phoneme);
  }
  return normalized;
}
```

---

## Testing Requirements

### Unit Tests
```
tests/
├── backend/
│   ├── session.test.js      # Mode switching, session persistence
│   ├── culturalContext.test.js  # Slang lookup, term explanation
│   └── colloquial.test.js   # Formal→colloquial suggestions
├── frontend/
│   ├── modeToggle.test.js   # UI mode switching
│   ├── i18n.test.js         # Language switching
│   └── audioControls.test.js # Interrupt, speed control
```

### Integration Tests
- [ ] Full conversation flow in Teaching Mode
- [ ] Full conversation flow in Free Talk Mode
- [ ] Mode switch mid-conversation
- [ ] "Correct Me" command → correction response
- [ ] Language switch → UI updates
- [ ] TTS speed change → playback speed changes

### Manual Testing Checklist
- [ ] Speech SDK loads in blocked network (VPN/firewall)
- [ ] 3-second pause doesn't cut off speech
- [ ] Interrupt button stops audio immediately
- [ ] Slang terms get cultural explanations
- [ ] Traditional/Simplified text renders correctly

---

## Rollout Plan

### Week 1: P0 Stability
- Deploy SDK self-hosting fix
- Deploy pause threshold fix
- Deploy interrupt mechanism
- Monitor error rates

### Week 2-3: P1 Mode System
- Deploy backend mode support
- Deploy frontend mode toggle
- A/B test: 50% users get new modes
- Collect mode usage metrics

### Week 4-5: P2 Intelligence
- Deploy cultural database
- Deploy "Correct Me" feature
- Monitor colloquial suggestion adoption

### Week 6: P3 Polish
- Deploy UI language toggle
- Deploy speed slider
- Deploy countdown timer
- Full release to 100% users

---

## Success Metrics Tracking

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| P0 Bug Count | 4 | 0 | GitHub Issues |
| Mode Adoption (Teaching) | N/A | 40% | Analytics |
| Mode Adoption (Free Talk) | N/A | 60% | Analytics |
| DAU/WAU | Baseline | +20% | Analytics |
| NPS | Baseline | +10 pts | Survey |
| "Easy to use" feedback | 0 | 100+ | App reviews |
| Colloquial adoption rate | N/A | +15% | Backend logs |
| Crash-free sessions | ~90% | 100% | Monitoring |

---

## Appendix A: File Change Summary

| File | Changes |
|------|---------|
| `frontend/index.html` | Mode toggle, stop button, language selector, countdown ring |
| `frontend/app.js` | Mode state, interrupt logic, i18n, recording timer |
| `frontend/styles.css` | Mode toggle styles, countdown animation |
| `frontend/lib/speech-sdk/` | Self-hosted SDK bundle (NEW) |
| `frontend/i18n/index.js` | Localization strings (NEW) |
| `backend/server.js` | Mode endpoints, correction endpoint, cultural context |
| `backend/data/cantonese-culture.json` | Slang database (NEW) |
| `backend/services/culturalContext.js` | Cultural query service (NEW) |
| `backend/services/colloquialSuggestions.js` | Formal→colloquial mapping (NEW) |
| `backend/services/ttsNormalization.js` | TTS phoneme overrides (NEW) |

---

## Appendix B: API Changes

### New Endpoints
```
POST /api/mode
  Body: { sessionId, mode: 'teaching' | 'freeChat' }
  Response: { success: true, mode }

POST /api/correct  
  Body: { sessionId, utterance }
  Response: { correction: string }

GET /api/culture/slang/:term
  Response: { term, meaning, context, examples, politeAlternative }
```

### Modified Endpoints
```
POST /api/session
  Body: { mode?: 'teaching' | 'freeChat' }  // NEW PARAM
  Response: { sessionId, mode }

POST /api/recognize-and-respond
  Body: { sessionId, userText, scenario, mode }  // mode NOW REQUIRED
  Response: { aiText, feedback, ttsAudio, corrections?, colloquialSuggestions? }
```

---

**Document Status:** ✅ Ready for Implementation  
**Next Step:** Begin P0-1 (Self-Host Speech SDK Bundle)
