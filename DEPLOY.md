# APEX Humanoid — deploy guide

Face + optional ElevenLabs voice. Ek Node file, koi database nahi.

---

## Sabse aasan: Render (free)

### 1. GitHub pe daalo
```bash
git init
git add .
git commit -m "apex humanoid"
# GitHub pe naya repo banao (private bhi chalega), phir:
git remote add origin https://github.com/<tumhara-naam>/apex-humanoid.git
git branch -M main
git push -u origin main
```
`.gitignore` me `.env` already blocked hai — key kabhi push nahi hogi.

### 2. Render pe service banao
1. [render.com](https://render.com) → login with GitHub
2. **New +** → **Web Service**
3. Repo select karo
4. Settings:
   - **Runtime:** Node
   - **Build Command:** `npm install --omit=dev`
   - **Start Command:** `node server.js`
   - **Plan:** Free
5. **Environment → Add Environment Variable**
   - Key: `ELEVENLABS_API_KEY`
   - Value: `sk_...` (paste)
6. **Create Web Service** → 2-3 min wait

Link milega: `https://apex-humanoid-xxxx.onrender.com` — wahi kholo, ENTER dabao. Bas.

Voice automatic: page apne hi server ke `/tts` pe jaata hai (`tts:'auto'`), key browser tak kabhi nahi pahunchti.

---

## Alternativa

| Host | Kaise | Note |
|---|---|---|
| **Railway** | `railway init` → `railway up` → Variables me key | Render jaisa hi, free trial |
| **Fly.io** | `fly launch` → `fly secrets set ELEVENLABS_API_KEY=sk_...` | Dockerfile chahiye |
| **Vercel** | Sirf static face chalega | `/tts` ke liye alag serverless function likhna padega |
| **GitHub Pages** | Sirf static face | Voice nahi (koi server nahi) |

**Sirf face chahiye, voice nahi?** → GitHub Pages pe bhi chal jaayega, kyunki `apex-humanoid.html` single file hai aur browser voice se kaam chala leta hai.

---

## Render free tier ki 3 baatein

1. **Cold start:** 15 min inactivity ke baad service so jaati hai. Pehla kholne me **~50 second** lag sakta hai. Baad me normal.
2. **750 ghante/month** free — ek service ke liye kaafi.
3. **Custom domain** free tier me bhi lag sakta hai.

---

## Telegram channel (phone se command)

`telegram.js` — humanoid ka phone-friendly darwaza. Sirf ek token chahiye.

### 1. Bot banao (phone se, 2 min)
1. Telegram kholo → search **@BotFather**
2. `/newbot` → naam do → username do (end me `bot` hona chahiye)
3. Token milega: `123456789:ABCdef...`

### 2. Token daalo
Render → Environment → **Add** → `TELEGRAM_BOT_TOKEN` = token
(Aur chaho to `ALLOWED_CHAT_ID` — bot ko sirf aapke liye lock karne ke liye)

Start command badal do: `node telegram.js`
(ya dono ek saath chalane ke liye `node server.js & node telegram.js`)

### 3. Bot ko message karo
Telegram me apna bot kholo → **/start**

| Command | Kaam |
|---|---|
| `/start` | hello |
| `/status` | brain/voice/uptime |
| `/voice on` | jawab audio me bhi (ElevenLabs) |
| `/help` | list |
| kuch bhi likho | brain se jawab |
| voice note bhejo | transcribe + jawab (OpenAI key chahiye) |

### Render pe free me chalega?
Long polling hai, isliye haan — par free instance 15 min baad so jaata hai.
Roz ka assistant chahiye to **Starter ($7/mo)** ya ek chhota VPS.

---

## Local pe chalana (optional)
```bash
node server.js            # http://localhost:8787
# key ke saath:
ELEVENLABS_API_KEY=sk_... node server.js
# ya .env file me daal do, wo khud load ho jaati hai
```

---

## Key rotate karna
Render dashboard → Environment → `ELEVENLABS_API_KEY` edit → naya value → Save (auto redeploy).
Purani key ElevenLabs → Settings → API Keys se **revoke** kar do.

---

## Kya-kya file hai

| File | Kaam |
|---|---|
| `apex-humanoid.html` | Poora face (WebGL2, single file, zero deps) |
| `server.js` | Page serve + `/tts` (ElevenLabs proxy) + `/chat` (brain) |
| `package.json` | `npm start` |
| `render.yaml` | Render blueprint (auto config) |
| `.env.example` | Template — copy to `.env` for local |
| `.gitignore` | `.env`, `node_modules`, logs blocked |
