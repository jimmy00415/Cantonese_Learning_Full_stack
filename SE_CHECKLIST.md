# SE Iteration Quick Reference Checklist

## ✅ Phase 0 COMPLETED (February 1, 2026)

### P0-0: Fix Frontend-Backend Connectivity ✅ HOTFIX
- [x] Fixed wrong Azure URL (`hongkongtutor.azurewebsites.net` → `hongkongtutor-f4b5gzd3fbfdhxdw.eastasia-01.azurewebsites.net`)
- [x] Updated CORS to allow `localhost:*` for local development
- [x] Pushed to GitHub, verified GitHub Pages has correct URL
- [x] Verified Azure backend CORS allows `https://jimmy00415.github.io`

### P0-1: Self-Host Speech SDK ⏱️ 4h ✅ DONE
- [x] Downloaded `microsoft.cognitiveservices.speech.sdk.bundle-min.js` (441KB)
- [x] Created `frontend/lib/speech-sdk/` directory
- [x] Updated `frontend/index.html` with local SDK + CDN fallback
- [x] Added SDK version tracking (v1.38.0) in index.html + app.js

### P0-2: Fix SpeechRecognizer Error ⏱️ 4h ✅ DONE
- [x] Replaced `SpeechRecognizer.FromConfig()` with simple constructor
- [x] Set `speechConfig.speechRecognitionLanguage = 'zh-HK'`
- [x] Removed problematic `AutoDetectSourceLanguageConfig` usage
- [x] Added graceful fallback to typing mode if recognizer creation fails

### P0-3: Add Interrupt Mechanism ⏱️ 3h ✅ DONE
- [x] Added `stopAudio()` call in `handleRecordStart()` when audio is playing
- [x] Added "停止播放" button in index.html (hidden by default)
- [x] Button shows during SPEAKING state, hides otherwise
- [x] Added CSS styling for `.stop-btn`

### P0-4: Extend Pause Threshold ⏱️ 2h ✅ DONE
- [x] Set `EndSilenceTimeoutMs` to 3000ms
- [x] Set `InitialSilenceTimeoutMs` to 10000ms
- [x] Added pause timer with "唔緊要，慢慢講..." encouragement after 2s

---

## ✅ Phase 1 COMPLETED (February 2, 2026)

### P1-1: Mode System Architecture ✅ DONE
- [x] Session stores mode, history, settings, createdAt
- [x] POST /api/session accepts mode parameter
- [x] POST /api/mode endpoint for mid-session switching
- [x] generateAIResponse accepts mode parameter

### P1-2: Teaching Mode Prompt ✅ DONE
- [x] Strict corrections for all errors
- [x] Professional but encouraging tone
- [x] Correction format: 「原句」→「正確講法」+ 解釋

### P1-3: Free Talk Mode Prompt ✅ DONE
- [x] Minimal corrections (only if incomprehensible)
- [x] Relaxed, friendly tone
- [x] Uses slang and casual language

### P1-4: Frontend Mode Toggle UI ✅ DONE
- [x] Two-button toggle (Free Talk 💬 / Teaching 📚)
- [x] Active state styling with color coding
- [x] Mode-specific greetings on session start

### P1-5: Mode State Logic ✅ DONE
- [x] currentMode state variable
- [x] switchMode() syncs with backend
- [x] Mode change messages in transcript
- [x] Mode pill indicator in header

---

## 📊 Phase Summary

| Phase | Tasks | Est. Time | Status |
|-------|-------|-----------|--------|
| P0 | 4 critical fixes | 1 week | ✅ **COMPLETED** |
| P1 | Mode system (5 tasks) | 2 weeks | ✅ **COMPLETED** |
| P2 | Cultural engine + Feedback (3 tasks) | 2 weeks | 🟡 Ready to Start |
| P3 | UI polish (4 tasks) | 1 week | ⚪ Blocked by P2 |

---

## 🔑 Key Decisions Made

1. **Stability First** - Fix all P0 bugs before adding features
2. **Self-Host SDK** - Local bundle primary, CDN fallback only
3. **Single API Route** - Mode as session parameter, not separate endpoints
4. **Embedded Cultural DB** - JSON file, not external database
5. **Teaching Mode = Strict Corrections** - Every error corrected with explanation
6. **Free Talk Mode = Minimal Intervention** - Only correct if incomprehensible

---

## 📁 New Files to Create

```
frontend/
├── lib/
│   └── speech-sdk/
│       └── microsoft.cognitiveservices.speech.sdk.bundle-min.js
├── i18n/
│   └── index.js              # zh-TW, zh-CN, en translations

backend/
├── data/
│   └── cantonese-culture.json  # 200+ slang/idiom entries
├── services/
│   ├── culturalContext.js      # Slang lookup service
│   ├── colloquialSuggestions.js  # Formal→casual mapping
│   └── ttsNormalization.js     # SSML phoneme fixes
```

---

## ✅ Definition of Done

### For P0 Complete:
- [ ] SDK loads for users behind corporate firewalls
- [ ] SpeechRecognizer creates without console errors
- [ ] Users can interrupt AI speech mid-playback
- [ ] 3-second pauses don't cut off user speech
- [ ] Zero P0 bug reports for 48 hours

### For P1 Complete:
- [ ] Mode toggle visible and functional
- [ ] Teaching mode provides corrections every turn
- [ ] Free Talk mode rarely corrects
- [ ] Mode persists across page refresh

### For Full Release:
- [ ] All success metrics tracked in analytics
- [ ] NPS survey deployed
- [ ] Monitoring dashboards configured
- [ ] Rollback plan documented
