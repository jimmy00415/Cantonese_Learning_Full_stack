# Cantonese Conversation Tutor (Prototype)

A desktop-first web app prototype implementing the PRD. It wires a simple React-free frontend to a Node/Express backend with mocked ASR/LLM/TTS so you can exercise the flow without real cloud keys. Replace the mock hooks with actual providers when ready.

## What’s included
- `backend`: Express API with in-memory sessions, scenarios list, mock recognize-and-respond, and optional Azure TTS (falls back to mock data URI).
- `frontend`: Static HTML/CSS/JS desktop layout with chat transcript, scenario selector, “Hold to Speak (simulated)” button, text input fallback, playback speed selector, and replay-last control.
- `.env.example`: Backend configuration placeholders for Azure TTS plus future ASR/LLM keys.

## Quick start
### Backend
```powershell
cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack\backend
npm install                 # or "C:\Program Files\nodejs\npm.cmd" install
copy .env.example .env
npm run start             # or "C:\Program Files\nodejs\node.exe" server.js
# starts on http://localhost:4000
```

#### Azure TTS (optional)
Set these in `backend/.env` to enable Azure TTS; otherwise the API returns mock audio:

```env
AZURE_TTS_KEY=your-key
AZURE_TTS_REGION=eastus            # or your region
AZURE_TTS_VOICE=zh-CN-XiaoxiaoNeural
AZURE_TTS_RATE=0%                  # optional SSML rate adjustment
AZURE_TTS_PITCH=0%                 # optional SSML pitch adjustment
TTS_PROVIDER=azure                 # set to azure to use real TTS; omit for mock
```

### Frontend
```powershell
cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack\frontend
npm install                 # or "C:\Program Files\nodejs\npm.cmd" install
npm run start             # or npx serve -l 5173 .
# serves static site on http://localhost:5173
```

### Root scripts (convenience)
From repo root:
```powershell
# install root tools (concurrently)
npm install

# run dev servers separately
npm run dev:backend
npm run dev:frontend

# or run both together (backend + frontend)
npm run start:all
```
Open http://localhost:5173 in a desktop browser. The page will call the backend at http://localhost:4000.

## How it works (mocked)
1) Frontend sends text (simulating ASR) to `/api/recognize-and-respond` with the current session + scenario.
2) Backend generates a lightweight Cantonese reply, mock feedback, and either Azure TTS audio (when configured) or placeholder TTS data URI; keeps last 10 turns in memory.
3) Frontend appends user/AI bubbles, shows feedback, maintains status, and lets you play/replay audio at adjustable speed.

## Where to plug real services
- ASR: Replace the request body to accept audio blobs; stream to Google/Azure Speech, return transcript.
- LLM: Swap `mockAiReply` with an OpenAI/Azure OpenAI call; include conversation history and scenario hints.
- TTS: Replace `ttsAudio` placeholder with Azure/Google/Polly TTS output; return a URL or audio buffer.
- Session store: Move `conversations` to Redis or a database for multi-instance deployments.

## Next steps
- Implement real microphone capture on the frontend (MediaRecorder/Web Audio) with a toggle for push-to-talk or VAD.
- Secure auth + simple user profiles to retain transcripts and metrics.
- Observability: request latency logging, error tracking, and basic analytics (session length, feedback usage).

## Notes
- This prototype is desktop-oriented; mobile layout is not optimized.
- All Cantonese strings are static; update copy as desired for tone/persona.
