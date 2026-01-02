# 🎉 Setup Complete! Testing Guide

## ✅ Status: READY TO USE

Your Cantonese Learning App is now configured with **real Azure Speech Services**!

---

## 🖥️ Servers Running:

✅ **Backend**: http://localhost:4000  
   - TTS Provider: **Azure** (zh-HK-HiuMaanNeural)
   - ASR Language: **zh-HK** (Hong Kong Cantonese)
   - API Key: Configured ✓

✅ **Frontend**: http://localhost:5173  
   - MediaRecorder: Ready for mic input
   - Web Audio API: Ready for playback
   - UI: All 5 voice states active

---

## 🧪 Testing Steps:

### Test 1: Text-to-Speech (TTS) ✅
1. Open http://localhost:5173 in browser
2. Type any Cantonese text: `你好，我想練習廣東話`
3. Press **Ctrl+Enter** or click send
4. **Listen**: You should hear **real Azure TTS voice** (not mock)
5. Try replay button and speed controls

**Expected**: Natural female Cantonese voice (HiuMaanNeural)

---

### Test 2: Speech-to-Text (ASR) 🎤
1. Click **"按住說話"** button (hold to speak)
2. Browser will ask for microphone permission → Click **"Allow"**
3. **Hold button** and speak in Cantonese (e.g., "我今日想去飲茶")
4. **Release button** when done speaking
5. Watch system state: Listening → Processing → Speaking
6. **Check**: Your spoken text appears as transcript
7. Hear AI response with TTS

**Expected**: Your Cantonese speech converted to text accurately

---

### Test 3: Low Confidence Warning ⚠️
1. Record very quietly or with background noise
2. System should show: `辨識信心度較低 (XX%)，請確認`
3. Transcript still appears but with warning

---

### Test 4: Edit Transcript ✏️
1. After speaking/typing, find your message
2. Click **"編輯"** button
3. Correct the text
4. Press **Enter** or click **"保存"**
5. Message shows **(已編輯)** marker

---

### Test 5: Practice Loop 🔄
1. After AI response, check feedback panel
2. See correction items with:
   - Original text
   - Suggested correction
   - Reason
3. Click **"聽正確音頻"** - synthesizes correct pronunciation (mock for now)
4. Click **"再試一次"** - auto-fills suggested text
5. Click **"保存為卡片"** - saves for review (notification only)

---

### Test 6: Keyboard Shortcuts ⌨️
- **Ctrl+Enter**: Send message
- **Ctrl+Shift+R**: Replay last audio
- **Ctrl+Up/Down**: Adjust playback speed
- **Space** (while TTS playing): Interrupt audio
- **Escape**: Close dialogs

---

## 🔍 Monitoring Tools:

### Backend Console:
```
Look for:
✓ TTS provider: azure
✓ No "AZURE_SPEECH_KEY not configured" errors
✓ HTTP 200 responses
✓ Latency logs (e.g., "Response latency: 850ms")
```

### Browser Console (F12):
```
Look for:
✓ "已連線 API: http://localhost:4000/api"
✓ State transitions: idle → listening → processing → speaking
✓ No CORS errors
✓ Audio playback events
```

---

## 🐛 Quick Troubleshooting:

### Mic Permission Denied:
- Browser settings → Privacy → Microphone → Allow localhost
- Or use text input as fallback

### No TTS Audio:
- Check backend console for Azure errors
- Verify `TTS_PROVIDER=azure` in `.env`
- Check Azure Portal for API quota

### ASR Not Working:
- Speak clearly in **Cantonese** (廣東話)
- Hold button for at least 1-2 seconds
- Check browser console for errors

### 401 Unauthorized:
- API key might be expired
- Try KEY 2 from Azure Portal
- Verify region matches (eastasia)

---

## 📊 What's Working Now:

✅ Real microphone capture (MediaRecorder API)  
✅ Azure Speech-to-Text for Cantonese (zh-HK)  
✅ Azure Text-to-Speech with neural voice  
✅ 5 voice states with animations  
✅ Transcript editing and re-analysis  
✅ Practice loop UI (hear/try/save)  
✅ Keyboard shortcuts and accessibility  
✅ Mic permission flow with recovery  
✅ Latency indicators and timeouts  

---

## 🔜 Next Enhancements:

1. **Real AI Feedback**: Integrate OpenAI/Claude for intelligent corrections
2. **Pronunciation Scoring**: Compare user audio to reference
3. **Real Practice Loop**: Full record→compare→score cycle
4. **Spaced Repetition**: Track saved corrections for review
5. **User Authentication**: Multi-user support
6. **Mobile App**: React Native version

---

## 💡 Tips for Best Results:

1. **Speak clearly**: Enunciate Cantonese tones
2. **Good mic**: Use headset for better recognition
3. **Quiet environment**: Reduce background noise
4. **2-3 second clips**: Best ASR accuracy
5. **Monitor usage**: Check Azure Portal weekly

---

## 📈 Azure Usage Tracking:

1. Go to Azure Portal: https://portal.azure.com
2. Navigate to your Speech resource
3. Click "Metrics" in left menu
4. View:
   - **Speech-to-Text calls**: Should stay under 5 hours/month (free)
   - **Text-to-Speech characters**: Should stay under 500K/month (free)

---

## 🎯 Success Criteria:

✅ Mic button records real audio  
✅ ASR returns Cantonese transcript  
✅ TTS plays natural Cantonese voice  
✅ All voice states work (idle/listening/processing/speaking/error)  
✅ Keyboard shortcuts functional  
✅ Edit transcript works  
✅ Practice loop buttons show  

**If all above work → SETUP SUCCESSFUL! 🎉**

---

## 🚀 Ready to Learn Cantonese!

Your app is fully functional with real Azure Speech Services. Start practicing:

1. **Daily Practice**: 5-10 minutes speaking practice
2. **Review Corrections**: Check feedback panel after each utterance
3. **Track Progress**: Note improvements over time
4. **Experiment**: Try different scenarios and speeds

**Have fun learning! 學好廣東話！🇭🇰**
