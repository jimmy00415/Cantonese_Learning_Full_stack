# Simplify Parent-Brand Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an understated, accessible “from Simplify” parent-company attribution to Hong Kong Buddy and deploy the verified update to its existing Azure Web App.

**Architecture:** Keep `frontend` as the authoring source, add the supplied SVG under a dedicated brand asset path, and extend the existing sync manifest so `backend/public` remains the Azure-served mirror. Add static contract coverage for asset integrity, HTML semantics, responsive CSS, translations, and sync inclusion before changing presentation code.

**Tech Stack:** Static HTML/CSS/ES modules, Node.js `assert` contract tests, Express static hosting, PowerShell, Azure CLI, Azure App Service.

## Global Constraints

- Hong Kong Buddy remains the primary product brand; Simplify is the parent-company attribution.
- Use the exact supplied SVG with SHA-256 `80B8C7A6B9368CFDE4B41C776C48C7523D537350C28D300FD1F72736CBE5BB87`.
- Show the attribution persistently in the footer and explicitly in the About dialog.
- Do not add a Simplify hyperlink because no destination was supplied.
- Keep Traditional Chinese, Simplified Chinese, and English attribution copy in parity.
- Keep `frontend` and `backend/public` byte-for-byte synchronized through `scripts/sync-frontend-to-public.js`.
- Do not alter application state, APIs, authentication, provider behavior, the HK mark, or the favicon.
- Verify desktop and 390px mobile layouts before deployment.
- Deploy only after focused and regression checks pass; verify live HTML, SVG, `/api/health`, and provider/version fields afterward.

---

## File Structure

- Create `backend/scripts/test-simplify-brand-contract.js`: focused static contract for parent-brand attribution.
- Modify `backend/package.json`: expose the focused test as `test:simplify-brand`.
- Create `frontend/assets/brand/simplify-wordmark.svg`: canonical supplied company asset.
- Modify `frontend/index.html`: footer lockup and About ownership block.
- Modify `frontend/styles.css`: restrained desktop/mobile attribution styling.
- Modify `frontend/i18n/index.js`: three-locale company ownership copy.
- Modify `scripts/sync-frontend-to-public.js`: include the new asset in deployment synchronization.
- Generate the mirrored `backend/public` files only through `npm run sync:frontend`.

### Task 1: Add the failing Simplify brand contract

**Files:**
- Create: `backend/scripts/test-simplify-brand-contract.js`
- Modify: `backend/package.json`
- Test: `backend/scripts/test-simplify-brand-contract.js`

**Interfaces:**
- Consumes: repository files under `frontend` and `scripts/sync-frontend-to-public.js`.
- Produces: `npm --prefix backend run test:simplify-brand`, a fail-closed static contract used by later tasks.

- [ ] **Step 1: Write the focused contract**

Create the test with these exact checks:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..');
const frontendRoot = join(repoRoot, 'frontend');
const assetPath = join(frontendRoot, 'assets', 'brand', 'simplify-wordmark.svg');
const html = readFileSync(join(frontendRoot, 'index.html'), 'utf8');
const css = readFileSync(join(frontendRoot, 'styles.css'), 'utf8');
const i18n = readFileSync(join(frontendRoot, 'i18n', 'index.js'), 'utf8');
const syncScript = readFileSync(join(repoRoot, 'scripts', 'sync-frontend-to-public.js'), 'utf8');

assert.equal(existsSync(assetPath), true, 'Simplify wordmark should exist in frontend assets');
const asset = readFileSync(assetPath);
assert.equal(
  createHash('sha256').update(asset).digest('hex'),
  '80b8c7a6b9368cfde4b41c776c48c7523d537350c28d300fd1f72736cbe5bb87',
  'Simplify wordmark must match the supplied SVG exactly'
);
assert.match(html, /class="simplify-attribution"/, 'footer should expose Simplify attribution');
assert.match(html, /class="about-company-attribution"/, 'About should expose company attribution');
assert.match(html, /src="assets\/brand\/simplify-wordmark\.svg"/, 'HTML should use the canonical SVG');
assert.match(html, /alt="Simplify"/, 'wordmark should have accessible alt text');
assert.match(html, /data-i18n="guide\.about\.companyAttribution"/, 'About ownership copy should be localized');
assert.match(css, /\.simplify-attribution\b/, 'footer attribution should be styled');
assert.match(css, /\.about-company-attribution\b/, 'About attribution should be styled');
assert.equal((i18n.match(/companyAttribution:/g) || []).length, 3, 'all three locales need company attribution');
assert.match(syncScript, /'assets\/brand\/simplify-wordmark\.svg'/, 'sync manifest should include wordmark');

console.log('Simplify brand contract passed');
```

Add the exact package script:

```json
"test:simplify-brand": "node scripts/test-simplify-brand-contract.js"
```

- [ ] **Step 2: Run the contract and confirm the expected failure**

Run:

```powershell
npm --prefix backend run test:simplify-brand
```

Expected: FAIL with `Simplify wordmark should exist in frontend assets`.

- [ ] **Step 3: Commit the failing contract**

```powershell
git add -- backend/scripts/test-simplify-brand-contract.js backend/package.json
git commit -m "test: define Simplify brand attribution contract"
```

### Task 2: Implement the parent-company attribution

**Files:**
- Create: `frontend/assets/brand/simplify-wordmark.svg`
- Modify: `frontend/index.html`
- Modify: `frontend/styles.css`
- Modify: `frontend/i18n/index.js`
- Modify: `scripts/sync-frontend-to-public.js`
- Generate: `backend/public/assets/brand/simplify-wordmark.svg`
- Generate: `backend/public/index.html`
- Generate: `backend/public/styles.css`
- Generate: `backend/public/i18n/index.js`
- Test: `backend/scripts/test-simplify-brand-contract.js`

**Interfaces:**
- Consumes: the supplied SVG at `C:\Users\陈奕炜\Downloads\simplify-wordmark.svg` and the Task 1 contract.
- Produces: `.simplify-attribution`, `.about-company-attribution`, the `guide.about.companyAttribution` locale key, and the synchronized Azure static tree.

- [ ] **Step 1: Add the supplied SVG unchanged**

Add the supplied content exactly with `apply_patch`, then verify the canonical file hash:

```diff
*** Begin Patch
*** Add File: frontend/assets/brand/simplify-wordmark.svg
+<svg xmlns="http://www.w3.org/2000/svg" width="620" height="144" viewBox="0 0 620 144" role="img" aria-labelledby="title desc">
+  <title id="title">Simplify logo</title>
+  <desc id="desc">The Simplify symbol and Inter wordmark in monochrome.</desc>
+  <g fill="#050505">
+    <g transform="translate(24 30) scale(.179)">
+      <path d="M7 117 255 1q7-3 11 2 3 4-2 11L108 233q-5 8-11 5-3-1-6-5L2 128q-5-7-1-10 2-1 6-1Z"/>
+      <path d="M378 1q4-3 11 1l247 115q7 3 7 8 0 3-4 7l-88 102q-6 7-11 3-2-1-5-5L378 12q-5-7 0-11Z"/>
+      <path d="M20 374 289 24q5-7 11-3 3 2 3 9l9 288q0 11-8 14L27 385q-8 2-9-4-1-4 2-7Z"/>
+      <path d="m354 24 269 350q4 4 2 8-2 5-10 3l-277-53q-7-2-6-14l9-288q0-7 3-9 6-4 10 3Z"/>
+      <path d="m211 369 93-17q8-1 8 7v104q0 6-5 7-4 1-8-3l-89-88q-7-7 1-10Z"/>
+      <path d="m339 352 93 17q8 3 1 10l-89 88q-4 4-8 3-4-1-4-7V359q0-8 7-7Z"/>
+    </g>
+    <text x="164" y="96" font-family="Inter, Helvetica, Arial, sans-serif" font-size="64" font-weight="650" letter-spacing="-1.6">Simplify.</text>
+  </g>
+</svg>
*** End Patch
```

```powershell
Get-FileHash frontend\assets\brand\simplify-wordmark.svg -Algorithm SHA256
```

Expected hash: `80B8C7A6B9368CFDE4B41C776C48C7523D537350C28D300FD1F72736CBE5BB87`.

- [ ] **Step 2: Add the About and footer markup**

Insert after `.about-mission-grid`:

```html
<div class="about-company-attribution">
  <p data-i18n="guide.about.companyAttribution">Hong Kong Buddy is a product from Simplify.</p>
  <img src="assets/brand/simplify-wordmark.svg" alt="Simplify" />
</div>
```

Wrap the existing footer sentence and add the lockup before `.footer-links`:

```html
<div class="footer-brandline">
  <span>Hong Kong Buddy · Cantonese practice for international student life</span>
  <span class="simplify-attribution">
    <span class="simplify-attribution-label">from</span>
    <img src="assets/brand/simplify-wordmark.svg" alt="Simplify" />
  </span>
</div>
```

Change the stylesheet query token in `frontend/index.html` from
`styles.css?v=20260709layout2` to `styles.css?v=20260728simplify1`.

- [ ] **Step 3: Add localized ownership copy**

Add these exact `companyAttribution` values to the matching `guide.about` object:

```js
// zh-TW
companyAttribution: 'Hong Kong Buddy 係 Simplify 旗下產品。',
// zh-CN
companyAttribution: 'Hong Kong Buddy 是 Simplify 旗下产品。',
// en
companyAttribution: 'Hong Kong Buddy is a product from Simplify.',
```

- [ ] **Step 4: Add restrained responsive styling**

Add the following component rules near the existing About and footer rules:

```css
.about-company-attribution,
.footer-brandline,
.simplify-attribution {
  display: flex;
  align-items: center;
}

.about-company-attribution {
  justify-content: space-between;
  gap: 18px;
  padding-top: 16px;
  border-top: 1px solid rgba(60, 60, 67, 0.14);
}

.about-company-attribution p {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 700;
}

.about-company-attribution img {
  width: 108px;
  height: auto;
  flex: 0 0 auto;
}

.footer-brandline {
  justify-content: center;
  gap: 18px;
  flex-wrap: wrap;
}

.simplify-attribution {
  gap: 7px;
  color: var(--ink);
}

.simplify-attribution-label {
  color: var(--muted);
  font-size: 11px;
  font-weight: 700;
}

.simplify-attribution img {
  width: 88px;
  height: auto;
}

@media (max-width: 560px) {
  .about-company-attribution {
    align-items: flex-start;
    flex-direction: column;
  }

  .footer-brandline {
    flex-direction: column;
    gap: 8px;
  }
}
```

- [ ] **Step 5: Extend the sync manifest and generate the public mirror**

Add the asset path to `files` in `scripts/sync-frontend-to-public.js`:

```js
'assets/brand/simplify-wordmark.svg',
```

Then run:

```powershell
npm run sync:frontend
npm run sync:frontend:check
```

Expected: all listed files are copied, then `backend/public is in sync with frontend`.

- [ ] **Step 6: Run focused and shell tests**

```powershell
npm --prefix backend run test:simplify-brand
npm --prefix backend run test:v2-shell
```

Expected: both contracts pass.

- [ ] **Step 7: Commit the implementation**

```powershell
git add -- frontend/assets/brand/simplify-wordmark.svg frontend/index.html frontend/styles.css frontend/i18n/index.js scripts/sync-frontend-to-public.js backend/public/assets/brand/simplify-wordmark.svg backend/public/index.html backend/public/styles.css backend/public/i18n/index.js
git commit -m "feat: add Simplify parent-brand attribution"
```

### Task 3: Verify the complete local experience

**Files:**
- Test: `backend/scripts/test-simplify-brand-contract.js`
- Test: `backend/scripts/test-v2-regression-suite.js`
- Verify: `frontend/index.html`, `frontend/styles.css`, and the SVG at desktop and mobile viewports.

**Interfaces:**
- Consumes: Task 2’s synchronized static tree.
- Produces: test and browser evidence required to authorize deployment.

- [ ] **Step 1: Run the complete relevant regression ladder**

```powershell
npm run sync:frontend:check
npm --prefix backend run test:simplify-brand
npm --prefix backend run test:v2
```

Expected: sync check, focused brand contract, and V2 regression suite all pass.

- [ ] **Step 2: Start the backend locally**

```powershell
$env:PORT='3000'
npm --prefix backend start
```

Expected: Express listens on port 3000 and serves `backend/public`.

- [ ] **Step 3: Inspect desktop and mobile views**

Open `http://localhost:3000`, then verify at 1440×900 and 390×844:

- footer shows readable `from` plus the unmodified Simplify wordmark;
- About shows localized company ownership and the wordmark;
- no horizontal overflow, clipping, or header change;
- missing-image fallback would retain `Simplify` alt text.

- [ ] **Step 4: Confirm a clean implementation diff**

```powershell
git diff --check
git status --short --branch
```

Expected: no whitespace errors and only the planned ahead commits.

### Task 4: Redeploy and verify Azure

**Files:**
- No source mutation expected.
- External state: Azure App Service `hkbuddy-pilot-0630` in resource group `hkb-pilot-rg`.

**Interfaces:**
- Consumes: verified commits from Tasks 1–3.
- Produces: a ZIP deployment from the committed `backend` tree and live Azure evidence for the logo, HTML, health, version, and providers.

- [ ] **Step 1: Read back the authoritative Azure resource before deployment**

```powershell
$subscriptionId = '8cd98106-bf3f-4331-86b9-cdf784b35f4c'
$resourceGroup = 'hkb-pilot-rg'
$appName = 'hkbuddy-pilot-0630'
$app = az webapp show --subscription $subscriptionId --resource-group $resourceGroup --name $appName --query "{name:name,state:state,defaultHostName:defaultHostName}" -o json | ConvertFrom-Json
if ($app.name -ne $appName -or $app.state -ne 'Running') { throw 'Authoritative Hong Kong Buddy Azure app is not running' }
$appHost = $app.defaultHostName
```

Expected: `hkbuddy-pilot-0630` is `Running` and the live host is read from Azure rather than from stale deployment documentation.

- [ ] **Step 2: Record the pre-deployment live state**

```powershell
Invoke-RestMethod "https://$appHost/api/health" | ConvertTo-Json -Depth 8
```

Expected baseline: HTTP 200, `readyForPilot: true`, `llmProvider: azure-openai`, and the current `appVersion` is captured.

- [ ] **Step 3: Create a secret-safe deployment archive from the committed backend tree**

```powershell
$deployDir = Join-Path $env:TEMP 'hkbuddy-simplify-deploy'
New-Item -ItemType Directory -Force -Path $deployDir | Out-Null
$zipPath = Join-Path $deployDir 'backend.zip'
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
git archive --format=zip --output=$zipPath HEAD:backend
Get-Item -LiteralPath $zipPath | Select-Object FullName,Length
```

Expected: the ZIP contains only files committed under `backend`; it excludes `.env`, `.git`, local `node_modules`, and the visual-companion workspace.

- [ ] **Step 4: Deploy the archive directly to the verified Azure app**

```powershell
az webapp deploy --subscription $subscriptionId --resource-group $resourceGroup --name $appName --src-path $zipPath --type zip --clean true --restart true --timeout 900000
```

Expected: Azure reports a successful ZIP deployment. Stop and retain the existing live app if deployment fails; do not create or replace Azure resources.

- [ ] **Step 5: Bind the release identity only after successful deployment**

```powershell
$shortSha = git rev-parse --short=7 HEAD
$appVersion = "pilot-20260728-simplify-$shortSha"
az webapp config appsettings set --subscription $subscriptionId --resource-group $resourceGroup --name $appName --settings APP_VERSION=$appVersion --output none
```

Expected: the App Service restarts with a version string bound to the deployed commit.

- [ ] **Step 6: Poll and verify the live release**

```powershell
Invoke-WebRequest -UseBasicParsing "https://$appHost/assets/brand/simplify-wordmark.svg" | Select-Object StatusCode,Headers
$html = (Invoke-WebRequest -UseBasicParsing "https://$appHost/").Content
$html -match 'class="simplify-attribution"'
$html -match 'data-i18n="guide.about.companyAttribution"'
$health = Invoke-RestMethod "https://$appHost/api/health"
$health | ConvertTo-Json -Depth 8
if ($health.appVersion -ne $appVersion -or -not $health.readyForPilot) { throw 'Live release identity or readiness does not match the deployment' }
```

Expected: SVG returns HTTP 200, both HTML matches are `True`, `readyForPilot` remains true, `appVersion` equals the committed release identity, and provider fields remain healthy.

- [ ] **Step 7: Record final repository and deployment evidence**

```powershell
git status --short --branch
git log -4 --oneline --decorate
az webapp show --subscription $subscriptionId --resource-group $resourceGroup --name $appName --query "{name:name,state:state,host:defaultHostName,lastModifiedTimeUtc:lastModifiedTimeUtc}" -o json
```

Expected: clean local tree, local commits identify the deployed code, and Azure reports the target app as running at the verified host.
