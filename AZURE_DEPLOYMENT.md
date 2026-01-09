# Azure Deployment Guide

## 📦 Files Prepared for Deployment

✅ Backend configured for Azure App Service
✅ Frontend updated to use Azure backend URL
✅ CORS configured for both localhost and Azure domains

## 🚀 Deployment Steps

### Step 1: Configure Environment Variables in Azure

Go to your Azure Portal → **HongKongTutor** Web App → **Configuration** → **Application settings**

Add these environment variables (click "New application setting" for each):

```
AZURE_SPEECH_KEY = <your-azure-speech-key-from-.env>
AZURE_SPEECH_REGION = eastasia
AZURE_TTS_VOICE = zh-HK-HiuMaanNeural
HKBU_API_KEY = <your-hkbu-api-key-from-.env>
HKBU_BASE_URL = https://genai.hkbu.edu.hk/api/v0/rest
HKBU_MODEL = gpt-5
HKBU_API_VERSION = 2024-12-01-preview
TTS_PROVIDER = azure
CLIENT_ORIGIN = https://hongkongtutor-f4b5gzd3fbfdhxdw.eastasia-01.azurewebsites.net
```

**Note:** Copy the actual keys from your local `backend/.env` file - don't commit them to GitHub!

**Important:** Click **Save** at the top after adding all variables!

### Step 2: Deploy Backend Code

#### Option A: Using VS Code Azure Extension (Recommended)

1. Install "Azure App Service" extension in VS Code
2. Click Azure icon in left sidebar → Sign in
3. Right-click "HongKongTutor" → "Deploy to Web App"
4. Select the `backend` folder when prompted
5. Wait for deployment to complete

#### Option B: Using Azure CLI (In Terminal)

```powershell
# Refresh PATH first
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

# Login to Azure
az login

# Deploy backend
cd backend
az webapp up --name HongKongTutor --resource-group Cantonese_Tutor --plan ASP-CantoneseTutor-8927
```

#### Option C: Using Git Deployment

```powershell
# In Azure Portal → HongKongTutor → Deployment Center
# Choose "GitHub" → Authorize → Select your repository
# Branch: main
# Build Provider: App Service Build Service
```

### Step 3: Deploy Frontend

#### Option A: GitHub Pages (Simple, Free)

```powershell
# Commit and push all changes
git add .
git commit -m "Configure for Azure deployment"
git push origin main

# In GitHub repo → Settings → Pages
# Source: Deploy from a branch
# Branch: main → /frontend folder → Save
```

Your frontend will be at: `https://jimmy00415.github.io/Cantonese_Learning_Full_stack/`

Then update backend CORS:
- Go to Azure Portal → HongKongTutor → Configuration
- Add to `CLIENT_ORIGIN`: `https://jimmy00415.github.io`

#### Option B: Serve from Backend (All-in-One)

Copy frontend files to backend:
```powershell
Copy-Item -Path frontend/* -Destination backend/public -Recurse -Force
```

Then in backend/server.js, add:
```javascript
app.use(express.static('public'));
```

Redeploy backend, and your app will be at:
`https://hongkongtutor-f4b5gzd3fbfdhxdw.eastasia-01.azurewebsites.net`

### Step 4: Test Deployment

1. Wait 2-3 minutes for deployment to complete
2. Open: https://hongkongtutor-f4b5gzd3fbfdhxdw.eastasia-01.azurewebsites.net
3. Check backend health: Add `/api/health` to the URL
4. Test conversation: Type "你好" and send

## 🔧 Troubleshooting

**If backend shows errors:**
- Go to Azure Portal → HongKongTutor → Log stream
- Check deployment logs
- Verify all environment variables are set

**If CORS errors appear:**
- Check browser console
- Verify `CLIENT_ORIGIN` in Azure Configuration
- Make sure frontend URL matches allowed origins

**If audio doesn't work:**
- Verify `AZURE_SPEECH_KEY` is correct
- Check Azure Speech Services resource is active
- Region must be `eastasia`

## 📊 Monitor Your App

- **Logs:** Azure Portal → HongKongTutor → Log stream
- **Metrics:** Monitor → Metrics (CPU, Memory, Requests)
- **Alerts:** Set up alerts for downtime

## 💰 Cost Estimate

- App Service (P0v3): ~$60/month
- Azure Speech Services: Pay per use (~$1-5/month for testing)
- GitHub Pages: Free

---

**Ready?** Start with Step 1: Configure environment variables in Azure Portal!
