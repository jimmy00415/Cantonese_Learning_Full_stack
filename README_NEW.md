# Cantonese Conversation Tutor

A full-stack web app for learning Cantonese with **real-time speech recognition (ASR)** and **text-to-speech (TTS)**. Features voice interaction, pronunciation feedback, and an accessible UX following WCAG 2.2 guidelines.

## ✨ Features
- 🎤 **Real Microphone Recording**: Hold-to-speak with Azure Speech-to-Text
- 🗣️ **Natural Cantonese TTS**: Azure Neural Voice (zh-HK-HiuMaanNeural)
- 📝 **Transcript Editing**: Edit and re-analyze your spoken text
- 🎯 **Practice Loop**: Hear correct pronunciation, try again, save corrections
- ⚡ **5 Voice States**: Idle, listening, processing, speaking, error with animations
- ♿ **Accessibility**: Full keyboard navigation, ARIA semantics, screen reader support
- 🎨 **Modern UI**: Dark theme with responsive design

## 🚀 Quick Start

### 1. Backend Setup
```powershell
cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack\backend
npm install
copy .env.example .env
# Edit .env with your Azure credentials (see below)
npm start
# Backend runs on http://localhost:4000
```

### 2. Frontend Setup
```powershell
cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack\frontend
npm install
npm start
# Frontend serves on http://localhost:5173
```

### 3. Run Both Together (Recommended)
```powershell
cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack
npm install
npm run start:all
# Runs backend + frontend with concurrently
```

## 🔑 Azure Speech Services Setup

**Required for real ASR and TTS functionality.**

### Quick Setup:
1. **Create Azure account**: https://azure.microsoft.com/free/
2. **Create Speech resource** in Azure Portal (East Asia region recommended)
3. **Copy Key 1 and Region** from "Keys and Endpoint"
4. **Update `backend/.env`**:

```env
AZURE_SPEECH_KEY=your_key_here
AZURE_SPEECH_REGION=eastasia
AZURE_ASR_LANGUAGE=zh-HK
AZURE_TTS_VOICE=zh-HK-HiuMaanNeural
TTS_PROVIDER=azure
```

**📖 Detailed Guide**: See [AZURE_SETUP_GUIDE.md](./AZURE_SETUP_GUIDE.md) for step-by-step instructions, troubleshooting, and cost optimization.

### Free Tier Includes:
- ✅ 5 hours/month Speech-to-Text (ASR)
- ✅ 0.5M characters/month Neural TTS

---

## 📂 Project Structure

```
Cantonese_Tutor_Full_Stack/
├── backend/               # Express API server
│   ├── server.js         # Main server with ASR + TTS endpoints
│   ├── package.json      # Backend dependencies
│   ├── .env.example      # Configuration template
│   └── .env              # Your credentials (create from .env.example)
├── frontend/             # Static web app
│   ├── index.html        # Main HTML with accessible structure
│   ├── app.js            # Client logic with MediaRecorder API
│   ├── styles.css        # UI styling with voice states
│   └── package.json      # Frontend dependencies (serve)
├── AZURE_SETUP_GUIDE.md  # Detailed Azure setup instructions
├── PRD.markdown          # Original product requirements
└── package.json          # Root scripts for convenience
```

---

## 🎮 Usage

### With Microphone:
1. Click **"Allow"** when browser asks for microphone permission
2. **Hold "按住說話" button** and speak in Cantonese
3. **Release** to send audio for recognition
4. Hear AI response with natural TTS voice

### With Keyboard:
1. Type Cantonese text in input field
2. Press **Ctrl+Enter** to send
3. Press **Ctrl+Shift+R** to replay last audio
4. Press **Ctrl+Up/Down** to adjust playback speed
5. Press **Space** to interrupt TTS playback

### Editing Transcripts:
1. Click **"編輯"** on any user message
2. Correct the text
3. Press **Enter** or click **"保存"** to re-analyze

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Send message |
| `Ctrl+Shift+R` | Replay last audio |
| `Ctrl+Up` | Increase playback speed |
| `Ctrl+Down` | Decrease playback speed |
| `Space` | Interrupt TTS (when not typing) |
| `Escape` | Close dialogs |

---

## 🏗️ Architecture

### Backend (Node.js + Express)
- **POST /api/session**: Create new conversation session
- **POST /api/speech-to-text**: Convert audio → Cantonese text (Azure ASR)
- **POST /api/recognize-and-respond**: Process text → Generate AI response + TTS
- **GET /api/health**: Check server status and TTS provider
- **GET /api/scenarios**: List available practice scenarios

### Frontend (Vanilla JS)
- **MediaRecorder API**: Capture microphone audio
- **Web Audio API**: Playback control with speed adjustment
- **State Management**: 5 voice states (idle/listening/processing/speaking/error)
- **ARIA Live Regions**: Screen reader announcements
- **Modal Dialogs**: Mic permission request/recovery flows

### Data Flow:
```
User speaks → MediaRecorder → Base64 audio → Backend ASR endpoint
→ Transcript → Generate AI response → Azure TTS → Audio data
→ Frontend playback → State transitions → Feedback display
```

---

## 🔧 Development

### Dev Mode (with auto-reload):
```powershell
npm run dev:backend   # nodemon watches backend
npm run dev:frontend  # serve with live reload
```

### Without npm in PATH:
```powershell
& "C:\Program Files\nodejs\node.exe" backend/server.js
& "C:\Program Files\nodejs\node.exe" frontend/node_modules/serve/build/main.js -l 5173 frontend
```

---

## 🧪 Testing Without Azure

The app works in **mock mode** without Azure credentials:
- Set `TTS_PROVIDER=mock` in `backend/.env`
- ASR returns simulated transcript
- TTS returns mock base64 audio data URI

This is useful for:
- Development without cloud costs
- Testing UI/UX flows
- CI/CD pipelines

---

## 🌐 Deployment

### Option 1: Azure App Service
1. Create App Service in Azure Portal
2. Configure environment variables in Azure
3. Deploy via GitHub Actions or Azure CLI
4. Enable HTTPS and custom domain

### Option 2: Docker
```dockerfile
# Coming soon: Dockerfile for containerized deployment
```

---

## 🐛 Troubleshooting

### Microphone not working:
- Check browser permissions (chrome://settings/content/microphone)
- Use HTTPS (localhost works on HTTP)
- Try different browser (Chrome/Edge recommended)

### Azure API errors:
- Verify `AZURE_SPEECH_KEY` is correct
- Check `AZURE_SPEECH_REGION` matches resource region
- Monitor usage in Azure Portal (might exceed free tier)

### No audio playback:
- Check browser audio settings
- Verify TTS_PROVIDER=azure in .env
- Look for errors in browser console (F12)

**See [AZURE_SETUP_GUIDE.md](./AZURE_SETUP_GUIDE.md) for detailed troubleshooting.**

---

## 📊 Monitoring & Analytics

### Backend Logs:
- Server console shows request/response logs
- Latency metrics logged for each TTS/ASR call
- Error tracking with stack traces

### Browser Console:
- State transitions logged
- Audio playback events
- API call timing

---

## 🔒 Security Notes

1. **Never commit `.env`** - Contains API keys
2. **Rotate keys regularly** - Use Azure Portal
3. **Enable CORS properly** - Set CLIENT_ORIGIN in production
4. **Use HTTPS** - Required for microphone in production
5. **Rate limiting** - Add in production to prevent abuse

---

## 🚀 Future Enhancements

- [ ] OpenAI/Claude integration for intelligent feedback
- [ ] Pronunciation scoring with phoneme analysis
- [ ] Spaced repetition system for saved corrections
- [ ] Multi-user support with authentication
- [ ] Mobile app with React Native
- [ ] Offline mode with local speech recognition

---

## 📄 License

MIT License - See LICENSE file for details

---

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

---

## 📞 Support

- **GitHub Issues**: Report bugs or request features
- **Email**: [Your contact email]
- **Azure Support**: https://azure.microsoft.com/support/

---

**Ready to start learning Cantonese? 🎤🇭🇰**
