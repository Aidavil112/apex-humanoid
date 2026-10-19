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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg' };

const server = http.createServer(async (req, res) => {
  /* permissive CORS so the HTML can be opened from file:// or any port */
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

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

server.listen(PORT, '0.0.0.0', () => {
  console.log('brain + page on http://0.0.0.0:' + PORT);
  console.log('  brain:', process.env.OPENAI_API_KEY ? 'openai'
           : process.env.GEMINI_API_KEY ? 'gemini' : 'local rules (no key set)');
  console.log('  voice:', EL_KEY ? 'elevenlabs ' + EL_MODEL : 'browser speechSynthesis (no key set)');
});
