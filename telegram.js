/* ---------------------------------------------------------------
   Telegram channel for the humanoid — phone se command, server kare.
   No dependencies. Long polling, so it works on any free host.

   Setup (2 min, phone se hi):
     1. Telegram me @BotFather -> /newbot -> naam do -> token milega
     2. Host ke Environment me daalo:  TELEGRAM_BOT_TOKEN=123:ABC
     3. Node chalao:  node telegram.js
     4. Apne bot ko Telegram me /start bhejo

   Env used: TELEGRAM_BOT_TOKEN (required)
             OPENAI_API_KEY | GEMINI_API_KEY (optional brain)
             ELEVENLABS_API_KEY (optional: voice replies)
             ALLOWED_CHAT_ID (optional: lock the bot to only you)
   --------------------------------------------------------------- */
const fs = require('fs');
const path = require('path');

/* tiny .env loader, same as server.js */
(function loadEnv(){
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
})();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const API = 'https://api.telegram.org/bot' + TOKEN;
const ALLOWED = process.env.ALLOWED_CHAT_ID || '';
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';

if (!TOKEN) { console.error('TELEGRAM_BOT_TOKEN missing — see .env.example'); process.exit(1); }

/* ------------------------------- brain ---------------------------------- */
const SYSTEM = 'You are a concise personal assistant talking over Telegram. ' +
  'Reply in the same language the user writes in (Hindi/Hinglish is fine). ' +
  'Keep replies under 60 words unless asked for detail. No markdown tables.';

async function askOpenAI(text){
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: text }],
      max_tokens: 300, temperature: 0.6
    })
  });
  if (!r.ok) throw new Error('openai ' + r.status);
  return (await r.json()).choices[0].message.content.trim();
}

async function askGemini(text){
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: SYSTEM + '\n\nUser: ' + text }] }] }) }
  );
  if (!r.ok) throw new Error('gemini ' + r.status);
  return (await r.json()).candidates[0].content.parts[0].text.trim();
}

/* built-in tools that need no key */
function localTools(text){
  const t = text.toLowerCase();
  if (/^(hi|hey|hello|namaste|start)\b/.test(t))
    return 'Namaste. Bot zinda hai. Kuch bhi likho ya voice note bhejo — jawab dunga.\n\n' +
           'Humanoid control:\n' +
           '  /avatar kaze   — avatar badlo (nova, astra, unit7, kaze, vega, pip)\n' +
           '  /say namaste   — page bole\n' +
           '  /mood thinking — mood badlo\n' +
           '  /status, /voice on/off, /help';
  if (/time|samay|kitne baje/.test(t))
    return 'Abhi ' + new Date().toLocaleString('en-IN', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) + ' (IST).';
  if (/who are you|kaun ho|tum kaun/.test(t))
    return 'Main humanoid ka Telegram channel hoon — phone se tumhara message, server pe mera dimaag.';
  if (/help|madad|kya kar sakta/.test(t))
    return 'Commands:\n/start — hello\n/status — bot ki halat\n/voice on|off — voice reply\n/help — ye list\n\nBaaki kuch bhi likho, brain se jawab milega (key hone par).';
  return null;
}

async function think(text){
  const local = localTools(text);
  if (local) return local;
  /* one brain for the whole app: ask the page server first (/chat knows the
     current Gemini model names and falls back on its own). */
  try {
    const PORT = process.env.PORT || 8787;
    const r = await fetch('http://127.0.0.1:' + PORT + '/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (r.ok){
      const j = await r.json();
      if (j && j.text) return j.text;
    }
  } catch (e) { /* server route not up yet — fall through */ }
  try {
    if (process.env.OPENAI_API_KEY) return await askOpenAI(text);
    if (process.env.GEMINI_API_KEY) return await askGemini(text);
  } catch (e) {
    return 'Brain error: ' + e.message + '\n(API key check karo)';
  }
  return 'Abhi koi API key set nahi hai, isliye main sirf basic cheezein kar sakta hoon.\n' +
         'GEMINI_API_KEY daal do, phir kuch bhi poochho.';
}

/* ------------------------------- send ----------------------------------- */
const voiceChats = new Set();      // chats that asked for voice replies

async function tg(method, body){
  const r = await fetch(`${API}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json().catch(() => ({}));
}
const send = (chat_id, text, extra = {}) =>
  tg('sendMessage', { chat_id, text, disable_web_page_preview: true, ...extra });

async function sendVoice(chat_id, text){
  if (!EL_KEY) return false;
  try {
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}/stream?output_format=mp3_44100_128`,
      { method: 'POST',
        headers: { 'content-type': 'application/json', 'xi-api-key': EL_KEY, accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: process.env.ELEVENLABS_MODEL || 'eleven_v4_turbo',
                               voice_settings: { stability: 0.45, similarity_boost: 0.75 } }) }
    );
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    const form = new FormData();
    form.append('chat_id', String(chat_id));
    form.append('voice', new Blob([buf], { type: 'audio/mpeg' }), 'reply.mp3');
    const up = await fetch(`${API}/sendVoice`, { method: 'POST', body: form });
    return up.ok;
  } catch (e) { return false; }
}

async function transcribe(fileId){
  /* Telegram voice note -> text. Uses OpenAI whisper if available, else null. */
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const f = await tg('getFile', { file_id: fileId });
    const p = f.result && f.result.file_path;
    if (!p) return null;
    const bin = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${p}`);
    const buf = Buffer.from(await bin.arrayBuffer());
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/ogg' }), 'note.ogg');
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions',
      { method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: form });
    if (!r.ok) return null;
    return (await r.json()).text || null;
  } catch (e) { return null; }
}

/* ------------------------------- loop ----------------------------------- */
let offset = 0;
async function handleUpdate(u){
  const msg = u.message || u.edited_message;
  if (!msg) return;
  const chat_id = msg.chat.id;
  if (ALLOWED && String(chat_id) !== String(ALLOWED)) return;   // private bot

  /* voice note */
  if (msg.voice || msg.audio){
    const text = await transcribe((msg.voice || msg.audio).file_id);
    if (!text) return send(chat_id, 'Voice note mila, par transcribe karne ke liye OPENAI_API_KEY chahiye.');
    await send(chat_id, '🎙 ' + text);
    const reply = await think(text);
    await send(chat_id, reply);
    if (voiceChats.has(chat_id)) await sendVoice(chat_id, reply);
    return;
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  /* a pasted block of commands (one message, many lines) — run each line */
  if (/\n/.test(text)){
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean).slice(0, 8);
    if (lines.length > 1){
      for (const line of lines){
        await handleUpdate({ message: Object.assign({}, msg, { text: line }) });
      }
      return;
    }
  }

  /* ---- humanoid control: forwarded to the local server (same free service) ---- */
  const PORT = process.env.PORT || 8787;
  async function toPage(obj){
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/cmd', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj)
      });
      const j = await r.json();
      return j && j.ok ? '# ' + j.seq : 'page offline';
    } catch (e){ return 'page offline (' + e.message + ')'; }
  }
  const mSay = text.match(/^\/say\s+([\s\S]+)/i);
  if (mSay){ const r = await toPage({ say: mSay[1].trim() }); return send(chat_id, '🗣 ' + mSay[1].trim() + '\n' + r); }
  const mAv = text.match(/^\/avatar(?:\s+(\w+))?/i);
  if (mAv){
    if (!mAv[1]) return send(chat_id, 'Avatars: nova, astra, unit7, kaze, vega, pip\nUse: /avatar kaze');
    return send(chat_id, '◈ ' + mAv[1] + '  ' + await toPage({ avatar: mAv[1].toLowerCase() }));
  }
  const mMood = text.match(/^\/mood\s+(\w+)/i);
  if (mMood) return send(chat_id, 'mood ' + mMood[1] + '  ' + await toPage({ mood: mMood[1].toLowerCase() }));

  /* commands */
  if (text === '/start'){
    voiceChats.delete(chat_id);
    return send(chat_id, localTools('hello'));
  }
  if (text === '/status'){
    return send(chat_id,
      'Chat: ' + chat_id + '\n' +
      'Brain: ' + (process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'local only') + '\n' +
      'Voice: ' + (EL_KEY ? (voiceChats.has(chat_id) ? 'elevenlabs (on)' : 'elevenlabs (off)') : 'not configured') + '\n' +
      'Uptime: ' + Math.round(process.uptime()) + 's');
  }
  if (text.startsWith('/voice')){
    const on = /on|chalu|yes/i.test(text);
    on ? voiceChats.add(chat_id) : voiceChats.delete(chat_id);
    return send(chat_id, 'Voice replies ' + (on ? 'on' : 'off') + (on && !EL_KEY ? ' — par ELEVENLABS_API_KEY set nahi hai' : ''));
  }
  if (text === '/help') return send(chat_id, localTools('help'));

  /* typing indicator, then answer */
  await tg('sendChatAction', { chat_id, action: 'typing' });
  const reply = await think(text);
  await send(chat_id, reply);
  if (voiceChats.has(chat_id)) {
    const ok = await sendVoice(chat_id, reply);
    if (!ok) send(chat_id, '(voice reply fail — key/permission check karo)');
  }
}

async function poll(){
  try {
    const r = await fetch(`${API}/getUpdates?timeout=50&offset=${offset}`, { signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    for (const u of j.result || []){
      offset = u.update_id + 1;
      handleUpdate(u).catch(e => console.error('handler', e.message));
    }
  } catch (e) {
    if (!/abort|timeout/i.test(e.name + ' ' + e.message)) console.error('poll', e.message);
  }
  setTimeout(poll, 400);
}

console.log('telegram bot up · brain:',
  process.env.OPENAI_API_KEY ? 'openai' : process.env.GEMINI_API_KEY ? 'gemini' : 'local only',
  '· voice:', EL_KEY ? 'elevenlabs' : 'off',
  ALLOWED ? '· locked to ' + ALLOWED : '· open');
poll();
