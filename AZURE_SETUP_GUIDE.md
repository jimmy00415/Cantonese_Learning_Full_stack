# Azure Speech Services Setup Guide

## Overview
This guide will help you set up **real speech recognition (ASR)** and **text-to-speech (TTS)** for your Cantonese learning app using Azure Speech Services.

---

## Why Azure Speech Services?

✅ **Single Service**: Both ASR and TTS in one subscription  
✅ **Cantonese Support**: Excellent `zh-HK` (Hong Kong Cantonese) support  
✅ **Free Tier**: 5 hours/month speech-to-text + 0.5M characters TTS  
✅ **Low Latency**: Fast response times for conversational apps  
✅ **High Accuracy**: Industry-leading speech recognition

---

## Step 1: Create Azure Account

1. Go to **https://azure.microsoft.com/free/**
2. Click **"Start free"** or **"Try Azure for free"**
3. Sign in with Microsoft account (or create one)
4. Complete registration (requires credit card for verification, but won't charge within free tier)

---

## Step 2: Create Speech Resource

1. **Go to Azure Portal**: https://portal.azure.com
2. Click **"Create a resource"**
3. Search for **"Speech"** or **"Speech Services"**
4. Click **"Create"**

### Configuration:
- **Subscription**: Choose your subscription
- **Resource Group**: Create new (e.g., `cantonese-learning-rg`)
- **Region**: **East Asia** or **Southeast Asia** (recommended for Cantonese)
  - East Asia (Hong Kong): Best latency for HK users
  - Southeast Asia (Singapore): Good alternative
- **Name**: `cantonese-tutor-speech` (or any unique name)
- **Pricing Tier**: **Free F0** (for testing) or **Standard S0** (for production)

5. Click **"Review + create"** → **"Create"**
6. Wait for deployment (1-2 minutes)

---

## Step 3: Get Your API Credentials

1. After deployment, click **"Go to resource"**
2. In the left menu, click **"Keys and Endpoint"**
3. You'll see:
   - **KEY 1** (your API key)
   - **KEY 2** (backup key)
   - **Location/Region** (e.g., `eastasia`)

**Copy KEY 1 and Region** - you'll need these next!

---

## Step 4: Configure Your Backend

1. **Navigate to backend folder**:
   ```bash
   cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack\backend
   ```

2. **Create `.env` file** (copy from `.env.example`):
   ```bash
   copy .env.example .env
   ```

3. **Edit `.env` file** with your credentials:
   ```env
   PORT=4000
   CLIENT_ORIGIN=http://localhost:5173
   LOG_FORMAT=dev

   # Azure Speech Services
   AZURE_SPEECH_KEY=YOUR_KEY_HERE
   AZURE_SPEECH_REGION=eastasia

   # ASR Settings
   AZURE_ASR_LANGUAGE=zh-HK

   # TTS Settings
   AZURE_TTS_VOICE=zh-HK-HiuMaanNeural
   AZURE_TTS_RATE=0%
   AZURE_TTS_PITCH=0%

   # Enable Azure (change from 'mock' to 'azure')
   TTS_PROVIDER=azure
   ```

4. **Replace `YOUR_KEY_HERE`** with your actual KEY 1 from Azure Portal

---

## Step 5: Test the Integration

1. **Restart your backend**:
   ```bash
   cd d:\VS_PROJECT\Cantonese_Tutor_Full_Stack
   & "C:\Program Files\nodejs\node.exe" backend/server.js
   ```

2. **Check console output**:
   - Should see: `TTS provider: azure`
   - No error messages about missing keys

3. **Test in browser** (http://localhost:5173):
   - **Type a message** → Should hear **real Cantonese voice**
   - **Hold mic button** → Should **record and recognize** your speech

---

## Troubleshooting

### Issue: "AZURE_SPEECH_KEY not configured"
**Solution**: Make sure `.env` file exists in `backend/` folder and contains your key

### Issue: "Azure ASR failed: 401 Unauthorized"
**Solution**: 
- Check your API key is correct (no extra spaces)
- Verify key hasn't expired in Azure Portal
- Try using KEY 2 instead

### Issue: "Region mismatch error"
**Solution**: 
- Ensure `AZURE_SPEECH_REGION` matches your resource region
- Common values: `eastasia`, `southeastasia`, `westus`, `westeurope`

### Issue: "Recording works but no transcript"
**Solution**:
- Speak clearly in **Cantonese** (廣東話)
- Recording needs at least 1-2 seconds of audio
- Check browser console for error messages

### Issue: "Browser blocks microphone"
**Solution**:
- Allow microphone permission when prompted
- Check browser settings → Privacy → Microphone
- Try using HTTPS (localhost should work)

---

## Free Tier Limits

**Speech-to-Text (ASR)**:
- ✅ 5 hours/month free
- After limit: $1 USD per hour

**Text-to-Speech (TTS)**:
- ✅ 0.5 million characters/month free (Neural voices)
- After limit: $16 USD per 1M characters

**Monitoring Usage**:
1. Azure Portal → Your Speech Resource
2. Click **"Metrics"** in left menu
3. View real-time usage

---

## Alternative: Google Cloud Speech

If you prefer Google Cloud:

1. **Create project**: https://console.cloud.google.com
2. **Enable APIs**: Cloud Speech-to-Text API, Cloud Text-to-Speech API
3. **Create service account** → Download JSON key
4. **Update backend code** to use Google APIs instead of Azure

---

## Next Steps After Setup

1. ✅ **Test basic recording**: Hold mic button and speak
2. ✅ **Test TTS**: Type a message and listen
3. 🔜 **Add OpenAI/Claude**: For intelligent conversation feedback
4. 🔜 **Deploy to Azure App Service**: Make it accessible online
5. 🔜 **Add pronunciation scoring**: Compare user pronunciation to correct audio

---

## Cost Optimization Tips

1. **Use Free Tier First**: Test thoroughly before upgrading
2. **Cache TTS Results**: Already implemented (50-entry cache)
3. **Limit Recording Duration**: Prevent excessive usage
4. **Monitor Dashboard**: Check usage weekly
5. **Set Budget Alerts**: Azure Portal → Cost Management → Budgets

---

## Support Resources

- **Azure Speech Docs**: https://learn.microsoft.com/azure/cognitive-services/speech-service/
- **Cantonese Voice Samples**: https://speech.microsoft.com/portal/voicegallery
- **Pricing Calculator**: https://azure.microsoft.com/pricing/calculator/
- **GitHub Issues**: Report bugs in your repo

---

**Ready to go live? Your app now has real ASR and TTS! 🎤🗣️**
