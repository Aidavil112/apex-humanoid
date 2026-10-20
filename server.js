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

async function askGemini(text, history) {
  history = Array.isArray(history)
    ? history.filter(h => h && h.role && h.text)
             .map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 800) }] }))
    : [];
  const key = process.env.GEMINI_API_KEY;
  const BASE = 'https://generativelanguage.googleapis.com/v1beta';
  /* Model names move fast (2.5-flash was retired 20 Oct 2026). Newest first,
     then fall back to whatever the key can actually see. */
  /* voice-first order: the lite models answer in about a second, the big ones
     think for many seconds. Swap with GEMINI_MODEL if you want smarter/slower. */
  const models = [process.env.GEMINI_MODEL, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
                  'gemini-3.8-flash', 'gemini-flash-latest']
                 .filter(Boolean);
  let lastErr = 'no model tried';
  const ask = async (model) => {
    /* hard 8s cap per model: a spoken reply that takes longer is useless */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let r;
    try {
      r = await fetch(`${BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: history.concat([{ role: 'user', parts: [{ text }] }]),
          systemInstruction: { parts: [{ text: 'You are the voice behind a small glowing particle humanoid. Answer in ONE short spoken sentence, at most 15 words. No markdown, no lists. Match the user language (Hindi or English).' }] },
          generationConfig: {
            maxOutputTokens: 120,
            temperature: 0.85,
            thinkingConfig: { thinkingBudget: 0 }      /* thinking = seconds of silence */
          }
        })
      });
    } finally { clearTimeout(timer); }
    if (r.status === 400){
      /* some models reject thinkingConfig — retry the same model without it */
      const r2 = await fetch(`${BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: history.concat([{ role: 'user', parts: [{ text }] }]),
          systemInstruction: { parts: [{ text: 'You are the voice behind a small glowing particle humanoid. Answer in ONE short spoken sentence, at most 15 words. No markdown, no lists. Match the user language (Hindi or English).' }] },
          generationConfig: { maxOutputTokens: 120, temperature: 0.85 }
        })
      });
      if (!r2.ok) throw new Error(model + ' ' + r2.status);
      const j2 = await r2.json();
      const o2 = j2.candidates && j2.candidates[0] && j2.candidates[0].content &&
                 j2.candidates[0].content.parts && j2.candidates[0].content.parts[0] &&
                 j2.candidates[0].content.parts[0].text;
      if (!o2) throw new Error(model + ' empty reply');
      return o2.trim();
    }
    if (!r.ok) throw new Error(model + ' ' + r.status);
    const j = await r.json();
    const out = j.candidates && j.candidates[0] && j.candidates[0].content &&
                j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
                j.candidates[0].content.parts[0].text;
    if (!out) throw new Error(model + ' empty reply');
    return out.trim();
  };
  for (const m of models){
    try { return await ask(m); } catch (e){ lastErr = e.message; }
  }
  /* last resort: ask Google what this key may use, then try the first text model */
  try {
    const r = await fetch(`${BASE}/models?pageSize=100`, { headers: { 'x-goog-api-key': key } });
    const j = await r.json();
    const cand = (j.models || []).find(m =>
      (m.supportedGenerationMethods || []).includes('generateContent') &&
      !/image|tts|audio|embedding|veo|imagen|lyria/i.test(m.name));
    if (cand){
      try { return await ask(cand.name.replace(/^models\//, '')); }
      catch (e){ lastErr = e.message; }
    }
  } catch (e){ lastErr += ' | list failed: ' + e.message; }
  throw new Error(lastErr);
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

/* ---------------------------------------------------------------------------
   3D PRINTER BRIDGE (OctoPrint / Klipper-Moonraker style REST)
   Works with nothing configured: every call says "no printer configured".
   Env: OCTOPRINT_URL  e.g. http://192.168.1.50   (+ optional OCTOPRINT_API_KEY)
   --------------------------------------------------------------------------- */
const PRINTER_URL = (process.env.OCTOPRINT_URL || '').replace(/\/+$/, '');
const PRINTER_KEY = process.env.OCTOPRINT_API_KEY || '';
const PRINTER_KIND = (process.env.PRINTER_KIND || 'octoprint').toLowerCase();   /* octoprint | moonraker */

async function printerCall(pathname, method, body){
  if (!PRINTER_URL) throw Object.assign(new Error('no printer configured (set OCTOPRINT_URL)'), { code: 501 });
  const headers = { 'content-type': 'application/json' };
  if (PRINTER_KEY) headers['X-Api-Key'] = PRINTER_KEY;
  const sep = pathname.includes('?') ? '&' : '?';
  const url = PRINTER_URL + pathname + (PRINTER_KEY && PRINTER_KIND === 'moonraker' ? sep + 'apikey=' + encodeURIComponent(PRINTER_KEY) : '');
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error('printer ' + r.status + ': ' + txt.slice(0, 160)), { code: 502 });
  return json || { raw: txt.slice(0, 200) };
}

/* demo state so the whole path can be seen before any hardware exists */
const DEMO = { file: 'benchy.gcode', started: Date.now() };
function demoStatus(){
  const mins = (Date.now() - DEMO.started) / 60000;
  const pct = Math.min(97, Math.round(6 + mins * 4));
  return { configured: false, demo: true, state: 'Printing (demo)', file: DEMO.file,
           progress: pct, timeLeft: Math.max(1, Math.round(24 - mins)) + ' min',
           hint: 'ye nakli printer hai. Asli ke liye OCTOPRINT_URL set karo.' };
}
async function printerStatus(){
  if (!PRINTER_URL) return demoStatus();
  if (PRINTER_KIND === 'moonraker'){
    const j = await printerCall('/printer/objects/query?print_stats&virtual_sdcard', 'GET');
    const st = (j.result && j.result.status) || {};
    const ps = st.print_stats || {};
    const vd = st.virtual_sdcard || {};
    return { configured: true, kind: 'moonraker', state: ps.state || 'unknown',
             file: ps.filename || null, progress: vd.progress ? Math.round(vd.progress*100) : null };
  }
  const job = await printerCall('/api/job', 'GET');
  const pr  = await printerCall('/api/printer', 'GET');
  return { configured: true, kind: 'octoprint',
           state: (pr.state && pr.state.text) || 'unknown',
           file: job.job && job.job.file && job.job.file.name || null,
           progress: job.progress && job.progress.completion != null ? Math.round(job.progress.completion) : null,
           timeLeft: job.progress && job.progress.printTimeLeft != null ? Math.round(job.progress.printTimeLeft/60) + ' min' : null };
}

async function printerStart(file){
  if (!PRINTER_URL){
    if (!file) throw Object.assign(new Error('file name required, e.g. benchy.gcode'), { code: 400 });
    DEMO.file = file; DEMO.started = Date.now();
    console.log('printer demo: start', file);
    return 'demo: started ' + file + ' (no real printer configured)';
  }
  if (!file) throw Object.assign(new Error('file name required, e.g. benchy.gcode'), { code: 400 });
  if (PRINTER_KIND === 'moonraker'){
    await printerCall('/printer/print/start?filename=' + encodeURIComponent(file), 'POST');
    return 'started ' + file;
  }
  await printerCall('/api/files/local/' + encodeURIComponent(file), 'POST', { command: 'select', print: true });
  return 'started ' + file;
}

async function printerStop(){
  if (!PRINTER_URL){ DEMO.started = Date.now() - 9999999; console.log('printer demo: stop'); return 'demo: cancelled'; }
  if (PRINTER_KIND === 'moonraker'){ await printerCall('/printer/print/cancel', 'POST'); return 'cancelled'; }
  await printerCall('/api/job', 'POST', { command: 'cancel' });
  return 'cancelled';
}

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
  { name: 'printer_status',
    description: 'Read the 3D printer state, current file and progress.',
    inputSchema: { type:'object', properties:{} } },
  { name: 'printer_start',
    description: 'Start printing a gcode file that is already on the printer.',
    inputSchema: { type:'object', properties:{ file:{ type:'string' } }, required:['file'] } },
  { name: 'printer_stop',
    description: 'Cancel the current print job.',
    inputSchema: { type:'object', properties:{} } },
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
    case 'printer_status':
      return printerStatus().then(j => JSON.stringify(j));
    case 'printer_start':
      return printerStart(args.file);
    case 'printer_stop':
      return printerStop();
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
          const out = await Promise.resolve(mcpCall(p.name, p.arguments));
          return reply({ content: [{ type:'text', text: typeof out === 'string' ? out : JSON.stringify(out) }], isError: false });
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

  /* ---- printer bridge (works with nothing configured: says so) ---- */
  if (req.url.split('?')[0].startsWith('/printer')) {
    const p = req.url.split('?')[0];
    (async () => {
      try {
        let out;
        if (p === '/printer' || p === '/printer/status') out = await printerStatus();
        else if (p === '/printer/start' && req.method === 'POST'){
          const body = await readBody(req, 1e5);
          let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) {}
          out = { ok: true, result: await printerStart(j.file) };
        }
        else if (p === '/printer/stop' && req.method === 'POST') out = { ok: true, result: await printerStop() };
        else { res.writeHead(404, {'content-type':'application/json'}); return res.end(JSON.stringify({ error:'unknown printer route' })); }
        res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
        res.end(JSON.stringify(out));
      } catch (e){
        res.writeHead(e.code || 502, {'content-type':'application/json'});
        res.end(JSON.stringify({ error: e.message }));
      }
    })();
    return;
  }

  /* ---- diagnostics: is a key visible to this process? ---- */
  if (req.url.split('?')[0] === '/health' && req.method === 'GET') {
    const g = process.env.GEMINI_API_KEY || '';
    const o = process.env.OPENAI_API_KEY || '';
    const t = process.env.TELEGRAM_BOT_TOKEN || '';
    const mask = v => v ? v.slice(0, 6) + '…' + v.slice(-4) + ' (len ' + v.length + ')' : 'not set';
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify({
      GEMINI_API_KEY: mask(g),
      OPENAI_API_KEY: mask(o),
      TELEGRAM_BOT_TOKEN: mask(t),
      telegramEnvKeys: Object.keys(process.env).filter(k => /TELE|GEM|OPENAI/i.test(k)),
      model: process.env.GEMINI_MODEL || 'auto (3.8-flash → 3.6 → 3.5-lite → 3.1-lite → discover)',
      schedule: SCHEDULE.map(s => s.key),
      printer: PRINTER_URL ? PRINTER_KIND + ' @ ' + PRINTER_URL : 'not configured'
    }, null, 1));
  }

  /* ---- what the page polls ---- */
  if (req.url.split('?')[0] === '/state' && req.method === 'GET') {
    res.writeHead(200, {'content-type':'application/json','cache-control':'no-store'});
    return res.end(JSON.stringify(STATE));
  }

  /* ---- brain diagnostics: which models this key can actually use ---- */
  if (req.url.split('?')[0] === '/diag' && req.method === 'GET') {
    const key = process.env.GEMINI_API_KEY;
    if (!key){ res.writeHead(500, {'content-type':'application/json'}); return res.end(JSON.stringify({error:'GEMINI_API_KEY not set'})); }
    const probe = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite',
                   'gemini-2.5-flash-preview-tts', 'gemini-3.5-flash-preview-tts',
                   'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts'];
    const out = { keyLen: key.length, keyPrefix: key.slice(0,3), models: [], list: null };
    for (const m of probe){
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent',
          { method:'POST', headers: { 'content-type':'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({ contents:[{ role:'user', parts:[{ text:'hi' }] }],
              generationConfig: { maxOutputTokens: 8, thinkingConfig: { thinkingBudget: 0 } } }) });
        const t = (await r.text()).slice(0, 220);
        out.models.push({ model: m, status: r.status, body: t });
      } catch (e){ out.models.push({ model: m, status: 'ERR', body: e.message }); }
    }
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
      const j = await r.json();
      out.list = (j.models || []).map(m => m.name.replace(/^models\//, '')).filter(n => !/image|tts|audio|embedding|veo|imagen|lyria/i.test(n));
    } catch (e){ out.list = 'failed: ' + e.message; }
    res.writeHead(200, {'content-type':'application/json'});
    return res.end(JSON.stringify(out, null, 1));
  }

  /* ---- streaming brain: first words out in ~1s, speak while it writes ---- */
  if (req.url.split('?')[0] === '/chat/stream' && req.method === 'POST') {
    readBody(req, 1e6).then(async body => {
      let text = '', hist = [], want = '';
      try {
        const b = JSON.parse(body || '{}');
        text = (b.text || '').slice(0, 2000);
        hist = Array.isArray(b.history) ? b.history.slice(-8) : [];
        /* only ever a plain model id, never a URL or a prompt */
        if (typeof b.model === 'string' && /^gemini-[a-z0-9.\-]{2,40}$/.test(b.model)) want = b.model;
      } catch (e) {}
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const send = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      const key = process.env.GEMINI_API_KEY;
      if (!key){ send({ text: localReply(text), done: true }); return res.end(); }
      const history = hist.filter(h => h && h.role && h.text)
        .map(h => ({ role: h.role === 'model' ? 'model' : 'user', parts: [{ text: String(h.text).slice(0, 800) }] }));
      const models = [want, process.env.GEMINI_MODEL, 'gemini-3.1-flash-lite',
                      'gemini-3.5-flash-lite', 'gemini-3.8-flash']
                     .filter(Boolean)
                     .filter((m, i, a) => a.indexOf(m) === i);
      let wrote = false;
      for (const model of models){
        try {
          const r = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':streamGenerateContent?alt=sse',
            { method:'POST',
              headers: { 'content-type':'application/json', 'x-goog-api-key': key },
              body: JSON.stringify({
                contents: history.concat([{ role:'user', parts:[{ text }] }]),
                systemInstruction: { parts: [{ text: 'You are the voice behind a small glowing particle humanoid. Answer in ONE short spoken sentence, at most 15 words. No markdown. Match the user language (Hindi or English).' }] },
                generationConfig: { maxOutputTokens: 120, temperature: 0.9, thinkingConfig: { thinkingBudget: 0 } }
              })
            }
          );
          if (!r.ok) continue;
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          while (true){
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines){
              if (!line.startsWith('data:')) continue;
              const raw = line.slice(5).trim();
              if (!raw || raw === '[DONE]') continue;
              try {
                const j = JSON.parse(raw);
                const parts = j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
                const piece = parts && parts.map(p => p.text || '').join('');
                if (piece){ wrote = true; send({ text: piece }); }
              } catch (e) {}
            }
          }
          if (wrote){ send({ done: true }); return res.end(); }
        } catch (e) { /* try next model */ }
      }
      send({ text: 'Quota khatam ho gaya hai — Google ka free limit aaj ke liye khatam. Kal dopahar ke baad reset hoga.', done: true });
      res.end();
    });
    return;
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
      let hist = [];
      try { const b = JSON.parse(body || '{}'); text = (b.text || '').slice(0, 2000); hist = Array.isArray(b.history) ? b.history.slice(-8) : []; } catch (e) {}
      let reply;
      try {
        if (process.env.OPENAI_API_KEY) reply = await askOpenAI(text);
        else if (process.env.GEMINI_API_KEY) reply = await askGemini(text, hist);
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

/* ---- keep-alive: Render hands us our public URL, so ping ourselves every 10 min.
   Stops the free instance spinning down, which keeps the Telegram bot and the
   08:00 / 23:00 schedule alive. Disable with KEEPALIVE=off. ---- */
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '';
if (SELF_URL && String(process.env.KEEPALIVE || 'on').toLowerCase() !== 'off'){
  const pingUrl = SELF_URL.replace(/\/+$/, '') + '/health';
  setInterval(() => {
    fetch(pingUrl).then(r => console.log('keepalive', r.status)).catch(e => console.log('keepalive failed', e.message));
  }, 10 * 60 * 1000);
  console.log('keepalive: every 10 min ->', pingUrl);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('brain + page on http://0.0.0.0:' + PORT);
  console.log('  brain:', process.env.OPENAI_API_KEY ? 'openai'
           : process.env.GEMINI_API_KEY ? 'gemini' : 'local rules (no key set)');
  console.log('  voice:', EL_KEY ? 'elevenlabs ' + EL_MODEL : 'browser speechSynthesis (no key set)');
  console.log('  mcp  : POST /mcp  ·  page state GET /state');
  console.log('  auto : ' + (SCHEDULE.length ? SCHEDULE.map(s => s.key + ' IST').join(', ') + '  (GET /schedule)' : 'off'));
});
