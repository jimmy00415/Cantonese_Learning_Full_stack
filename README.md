# Cantonese Conversation Tutor / Hong Kong Buddy

> **Production V1 handoff:** active production work is isolated in
> [`production-v1/`](production-v1/) on branch
> `feat/production-v1-ai-senior`. It is not the legacy prototype described
> below. As of the 2026-09-01 handoff, the V1 infrastructure is only partially
> provisioned and no stable Production V1 URL or QR code has been released.

Agent-readable resume memory: [`production-v1/AGENT_HANDOFF.md`](production-v1/AGENT_HANDOFF.md).

## Continue Production V1 on another computer

```powershell
git clone https://github.com/jimmy00415/Cantonese_Learning_Full_stack.git
cd Cantonese_Learning_Full_stack
git switch feat/production-v1-ai-senior
cd production-v1
npm ci
$controlledBrowserRoot = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\playwright'
$controlledTempRoot = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\temp'
$controlledTmpRoot = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\tmp'
New-Item -ItemType Directory -Force -Path $controlledBrowserRoot, $controlledTempRoot, $controlledTmpRoot | Out-Null
$env:PLAYWRIGHT_BROWSERS_PATH = $controlledBrowserRoot
$env:TEMP = $controlledTempRoot
$env:TMP = $controlledTmpRoot
node node_modules/playwright/cli.js install chromium
npm run check
npm test
npm run security:dependencies
```

The full Task 8 browser evidence suite deliberately asserts that exact
controlled `D:` browser cache and task-owned temporary root. A generic clone,
or a computer without that `D:` path, cannot claim full `npm test` PASS. Do not
weaken or skip the evidence contract to make the suite green; treat inability
to reproduce that harness as an outstanding external release gate, not a
product regression.

Then follow the dated handoff and guarded GCP resume procedure in
[`production-v1/README.md`](production-v1/README.md) and
[`production-v1/infra/gcp/README.md`](production-v1/infra/gcp/README.md).
Authenticate again on the new computer; no OAuth code, API key, access token,
database password, or Secret Manager payload is stored in this repository.

Do not point Production V1 at the legacy Azure app, legacy storage, or any
unrelated resource in the shared GCP project. Do not treat a local preview,
contract test, candidate service, or planned Cloud Run hostname as a live
production release.

## Legacy prototype

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
