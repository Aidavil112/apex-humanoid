/* ---------------------------------------------------------------
   Optional brain for apex-humanoid.html
   Run:  node server.js            (then open http://localhost:8787)
   Then in the HTML set:  CONFIG.brain='endpoint';
                          CONFIG.brainUrl='http://localhost:8787/chat';

   No dependencies. If OPENAI_API_KEY (or GEMINI_API_KEY) is present the
   reply comes from a real model; otherwise it falls back to local rules
   so the loop still works offline.
   ElevenLabs TTS is proxied too, so the API key never reaches the browser:
     POST /tts { text, voiceId?, modelId? }  →  audio/mpeg
   --------------------------------------------------------------- */
const http = require('http');
const fs = require('fs');
const path = require('path');

/* --- tiny .env loader (no dependencies). KEY=value, # comments --- */
(function loadEnv(){
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    let v = m[2].trim().replace(/^["']|["']$/g, '');
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
})();

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;

const FALLBACK = [
  /^(hi|hey|hello|namaste)\b/i,
  /who are you|what are you/i,
  /what can you do/i
];
function localReply(text) {
  if (/^(hi|hey|hello|namaste)\b/i.test(text)) return 'Hello. The face is rendering, the brain is local.';
  if (/who are you|what are you/i.test(text)) return 'I am a point-cloud humanoid driven by your own server.';
  if (/time/i.test(text)) return 'It is ' + new Date().toLocaleTimeString('en-IN') + ' here.';
  return 'You said: "' + text.slice(0, 120) + '". Wire an API key and I will answer properly.';
}

async function askOpenAI(text) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + process.env.OPENAI_API_KEY
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are the voice behind a small glowing particle face. Answer in one or two short spoken sentences. No markdown.' },
        { role: 'user', content: text }
      ],
      max_tokens: 120,
      temperature: 0.7
    })
  });
  if (!r.ok) throw new Error('openai ' + r.status);
  const j = await r.json();
  return j.choices[0].message.content.trim();
}

async function askGemini(text) {
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply in one or two short spoken sentences, no markdown: ' + text }] }]
      })
    }
  );
  if (!r.ok) throw new Error('gemini ' + r.status);
  const j = await r.json();
  return j.candidates[0].content.parts[0].text.trim();
}

/* ---------------------------- ElevenLabs TTS ---------------------------- */
const EL_KEY = process.env.ELEVENLABS_API_KEY || '';
const EL_VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George (default library voice)
const EL_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_v4_turbo';        // ~100ms, best for agents

async function elevenTTS(text, voiceId, modelId) {
  const vid = voiceId || EL_VOICE;
  const mid = modelId || EL_MODEL;
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(vid)}/stream` +
    `?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': EL_KEY,
        accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: mid,
        voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true }
      })
    }
  );
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300).replace(/sk_[A-Za-z0-9_-]+/g, 'sk_***');
    const err = new Error('elevenlabs ' + r.status + ': ' + detail);
    err.status = r.status;
    throw err;
  }
  return Buffer.from(await r.arrayBuffer());
}

/* ---------------------------------------------------------------------------
   MCP bridge + page state
   The humanoid page polls GET /state. Any tool call (MCP, Telegram, curl)
   stamps a new action and the page applies it on the next tick.
   --------------------------------------------------------------------------- */
const STATE = { seq: 0, mood: null, avatar: null, say: null, theme: null, ts: 0 };
function IST_note(){
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false })
      .format(new Date()) + ' IST';
  } catch (e) { return new Date().toISOString(); }
}
function pushAction(a){
  STATE.seq++;
  STATE.ts = Date.now();
  for (const k of ['mood','avatar','say','theme']) if (a[k] !== undefined) STATE[k] = a[k];
  return STATE.seq;
}
function readBody(req, limit){
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
    req.on('end', () => resolve(body));
  });
}

/* ---------------------------------------------------------------------------
   SCHEDULE — the humanoid speaks on its own, with nobody typing.
   Free: it is just a timer inside this service.
   Env SCHEDULE:  "HH:MM=text | HH:MM=text"   (24h clock, IST)
   Times are read in Asia/Kolkata no matter what timezone the server runs in.
   --------------------------------------------------------------------------- */
const DEFAULT_SCHEDULE = '08:00=Good morning. Systems are awake and the room is quiet. | 23:00=It is eleven. Time to close the screen and sleep.';
function parseSchedule(str){
  return String(str || '').split('|').map(part => {
    const i = part.indexOf('=');
    if (i < 0) return null;
    const hm = part.slice(0, i).trim().match(/^(\d{1,2}):(\d{2})$/);
    const text = part.slice(i + 1).trim();
    if (!hm || !text) return null;
    const h = Math.min(23, parseInt(hm[1], 10)), m = Math.min(59, parseInt(hm[2], 10));
    return { h, m, text, key: (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m };
  }).filter(Boolean);
}
const SCHEDULE = parseSchedule(process.env.SCHEDULE || DEFAULT_SCHEDULE);
const fired = {};                      /* "2026-10-20 08:00" -> true */

function istParts(){
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const o = {};
  for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
  return o;                            /* {year, month, day, hour, minute} */
}
function scheduleTick(){
  const t = istParts();
  const key = t.year + '-' + t.month + '-' + t.day + ' ' + t.hour + ':' + t.minute;
  for (const s of SCHEDULE){
    if (s.h !== Number(t.hour) || s.m !== Number(t.minute)) continue;
    if (fired[key + ' ' + s.key]) continue;
    fired[key + ' ' + s.key] = true;
    pushAction({ say: s.text, mood: 'speaking' });
    console.log('schedule fired', s.key, '->', s.text.slice(0, 60));
  }
  /* keep the fired map small */
  const keys = Object.keys(fired);
  if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete fired[k];
}
if (SCHEDULE.length) setInterval(scheduleTick, 20000);

const MCP_TOOLS = [
  { name: 'humanoid_say',
    description: 'Make the humanoid speak a line out loud (browser speech synthesis on the viewer\'s device).',
    inputSchema: { type:'object', properties:{ text:{ type:'string', description:'what to say, one or two sentences' } }, required:['text'] } },
  { name: 'humanoid_set_mood',
    description: 'Change the humanoid mood: idle, listening, thinking or speaking.',
    inputSchema: { type:'object', properties:{ mood:{ type:'string', enum:['idle','listening','thinking','speaking'] } }, required:['mood'] } },
  { name: 'humanoid_set_avatar',
    description: 'Switch the avatar. Built from code: nova, astra, unit7. Portrait avatars: kaze (anime ninja), vega (founder), pip (3d cartoon).',
    inputSchema: { type:'object', properties:{ avatar:{ type:'string', enum:['nova','astra','unit7','kaze','vega','pip'] } }, required:['avatar'] } },
  { name: 'humanoid_set_theme',
    description: 'Cycle the colour theme by index (0 = cyan).',
    inputSchema: { type:'object', properties:{ index:{ type:'integer' } }, required:['index'] } },
  { name: 'humanoid_schedule',
    description: 'List the automatic lines the humanoid speaks on its own (times in IST).',
    inputSchema: { type:'object', properties:{} } },
  { name: 'humanoid_status',
    description: 'Read the current humanoid state (last action sequence number, mood, avatar).',
    inputSchema: { type:'object', properties:{} } }
];

function mcpCall(name, args){
  args = args || {};
  switch (name){
    case 'humanoid_say': {
      const text = String(args.text || '').slice(0, 600);
      if (!text) throw new Error('text required');
      pushAction({ say: text });
      return 'spoken: ' + text;
    }
    case 'humanoid_set_mood': {
      const m = String(args.mood || '');
      if (!['idle','listening','thinking','speaking'].includes(m)) throw new Error('bad mood');
      pushAction({ mood: m });
      return 'mood -> ' + m;
    }
    case 'humanoid_set_avatar': {
      const a = String(args.avatar || '').toLowerCase();
      if (!['nova','astra','unit7','kaze','vega','pip'].includes(a)) throw new Error('bad avatar');
      pushAction({ avatar: a });
      return 'avatar -> ' + a;
    }
    case 'humanoid_set_theme': {
      pushAction({ theme: Number(args.index) | 0 });
      return 'theme -> ' + (Number(args.index) | 0);
    }
    case 'humanoid_schedule':
      return SCHEDULE.length
        ? SCHEDULE.map(s => s.key + ' IST — ' + s.text).join('\n')
        : 'no schedule set';
    case 'humanoid_status':
      return JSON.stringify({ seq: STATE.seq, mood: STATE.mood, avatar: STATE.avatar, lastActionAt: STATE.ts });
    default:
      throw new Error('unknown tool: ' + name);
  }
}

async function handleMcp(req, res){
  const raw = await readBody(req, 1e6);
  let msg;
  try { msg = JSON.parse(raw || '{}'); } catch(e){
    res.writeHead(400, {'content-type':'application/json'});
    return res.end(JSON.stringify({ jsonrpc:'2.0', id:null, error:{ code:-32700, message:'parse error' } }));
  }
  const id = (msg.id === undefined) ? null : msg.id;
  const reply = (result) => {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ jsonrpc:'2.0', id, result }));
  };
  const fail = (code, message) => {
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ jsonrpc:'2.0', id, error:{ code, message } }));
  };

  try {
    switch (msg.method){
      case 'initialize':
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'apex-humanoid', version: '1.0.0' }
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        res.writeHead(202); return res.end();
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: MCP_TOOLS });
      case 'tools/call': {
        const p = msg.params || {};
        try {
          const out = mcpCall(p.name, p.arguments);
          return reply({ content: [{ type:'text', text: String(out) }], isError: false });
        } catch (e){
          return reply({ content: [{ type:'text', text: 'error: ' + e.message }], isError: true });
        }
      }
      default:
        return fail(-32601, 'method not found: ' + msg.method);
    }
  } catch (e){
    return fail(-32603, e.message);
  }
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };

const server = http.createServer(async (req, res) => {
  /* permissive CORS so the HTML can be opened from file:// or any port */
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  /* ---- MCP endpoint (Streamable HTTP, JSON responses) ---- */
  if (req.url.split('?')[0] === '/mcp') {
    if (req.method === 'POST') return handleMcp(req, res);
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({ name:'apex-humanoid', transport:'streamable-http',
        note:'POST JSON-RPC 2.0 here. Tools: ' + MCP_TOOLS.map(t => t.name).join(', ') }));
    }
    res.writeHead(405); return res.end();
  }

  /* ---- what the page polls ---- */
  if (req.url.split('?')[0] === '/state' && req.method === 'GET') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify(STATE));
  }

  /* ---- one-shot event, the same thing Telegram/schedulers use ---- */
  if (req.url.split('?')[0] === '/event' && req.method === 'POST') {
    readBody(req, 1e5).then(body => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (e) {}
      const out = {};
      for (const k of ['say','mood','avatar','theme']) if (p[k] !== undefined) out[k] = p[k];
      if (!Object.keys(out).length) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:'nothing to do' })); }
      const seq = pushAction(out);
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ ok:true, seq, at: IST_note() }));
    });
    return;
  }

  if (req.url.split('?')[0] === '/schedule' && req.method === 'GET') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({ now: IST_note(), schedule: SCHEDULE.map(s => ({ time: s.key + ' IST', text: s.text })) }));
  }

  /* ---- plain REST control, handy from a phone or curl ---- */
  if (req.url.split('?')[0] === '/cmd' && req.method === 'POST') {
    readBody(req, 1e5).then(body => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (e) {}
      const out = {};
      for (const k of ['say','mood','avatar','theme']) if (p[k] !== undefined) out[k] = p[k];
      const seq = pushAction(out);
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ ok: true, seq }));
    });
    return;
  }

  if (req.url.startsWith('/chat') && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let text = '';
      try { text = (JSON.parse(body || '{}').text || '').slice(0, 2000); } catch (e) {}
      let reply;
      try {
        if (process.env.OPENAI_API_KEY) reply = await askOpenAI(text);
        else if (process.env.GEMINI_API_KEY) reply = await askGemini(text);
        else reply = localReply(text);
      } catch (e) {
        reply = localReply(text) + ' (model call failed: ' + e.message + ')';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: reply }));
    });
    return;
  }

  if (req.url.startsWith('/tts') && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', async () => {
      let p = {};
      try { p = JSON.parse(body || '{}'); } catch (e) {}
      const text = (p.text || '').slice(0, 4000);
      if (!text) { res.writeHead(400, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'text required'})); }
      if (!EL_KEY) { res.writeHead(503, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'ELEVENLABS_API_KEY not set'})); }
      try {
        const audio = await elevenTTS(text, p.voiceId, p.modelId);
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' });
        res.end(audio);
      } catch (e) {
        res.writeHead(e.status || 502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  /* root serves whichever page file is present */
  const home = fs.existsSync(path.join(ROOT, 'index.html')) ? '/index.html' : '/apex-humanoid.html';
  const url = req.url === '/' ? home : req.url.split('?')[0];

  /* never serve dotfiles, secrets, or the server's own source */
  const rel = decodeURIComponent(url);
  const blocked =
    /(^|\/)\./.test(rel) ||                       // .env, .git, .anything
    /(^|\/)(server\.js|package\.json|package-lock\.json)$/.test(rel) ||
    /(^|\/)(\.env|node_modules)/.test(rel);
  if (blocked) { res.writeHead(404); return res.end('not found'); }

  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---- Telegram channel rides along in the same free service ---- */
/* Built-in fallback so the bot works even when the dashboard env var is fiddly.
   Prefer the env var when it is valid; fall back to this one otherwise. */
const BUILTIN_TG = '8760517786:AAEuQK_sKupwXxo6rJndR5SG2y4b0twLyOM';
const TOKEN_RE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;
const envTG = (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || process.env.TG_TOKEN || '').trim();
const TG_TOKEN = TOKEN_RE.test(envTG) ? envTG : (TOKEN_RE.test(BUILTIN_TG) ? BUILTIN_TG : '');
console.log('telegram token source:', TOKEN_RE.test(envTG) ? 'env var' : (TG_TOKEN ? 'built-in' : 'none'));
if (TG_TOKEN) {
  try {
    const { spawn } = require('child_process');
    const child = spawn(process.execPath, [path.join(ROOT, 'telegram.js')],
      { env: Object.assign({}, process.env, { TELEGRAM_BOT_TOKEN: TG_TOKEN.trim(), PORT: String(PORT) }), stdio: 'inherit' });
    child.on('exit', c => console.log('telegram bot exited with code', c));
    console.log('telegram bot: started (token from ' + (TOKEN_RE.test(envTG) ? 'env var' : 'built-in') + ')');
  } catch (e) { console.log('telegram bot failed:', e.message); }
} else {
  console.log('telegram bot: skipped — TELEGRAM_BOT_TOKEN ' +
    (TG_TOKEN ? 'is set but the value does not look like a bot token (len ' + TG_TOKEN.trim().length + ')' : 'is not set'));
  console.log('  env keys I can see: ' + Object.keys(process.env)
    .filter(k => /TELE|TG_|BOT/i.test(k)).join(', ') || '  (no telegram-ish keys at all)');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('brain + page on http://0.0.0.0:' + PORT);
  console.log('  brain:', process.env.OPENAI_API_KEY ? 'openai'
           : process.env.GEMINI_API_KEY ? 'gemini' : 'local rules (no key set)');
  console.log('  voice:', EL_KEY ? 'elevenlabs ' + EL_MODEL : 'browser speechSynthesis (no key set)');
  console.log('  mcp  : POST /mcp  ·  page state GET /state');
  console.log('  auto : ' + (SCHEDULE.length ? SCHEDULE.map(s => s.key + ' IST').join(', ') + '  (GET /schedule)' : 'off'));
});
