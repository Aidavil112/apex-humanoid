# APEX HUMANOID — how a change gets made

A small, written rule for every future change to this page. It is the same loop that was used
to build the orb and the avatar switch: **look → write the check → change → verify live**.

---

## 1. Plan first (30 seconds, written down)

Before touching a file, three lines:

```
change:   what the user will see differently
file:     which file(s) change
check:    how we know it worked (exact selector / number / URL)
```

If the "check" line cannot be written, the change is not ready. No code yet.

## 2. Look before you edit

* `grep -n` the thing you are about to change. Read the surrounding 30 lines.
* Never edit from memory. `apex-humanoid.html` is the source of truth; `index.html` is a copy.
* If the page is live, note the current byte size of `https://apexhumanoid.onrender.com/` —
  that number is how you will prove the deploy landed.

## 3. Write the check, watch it fail

The check is usually one of:

* a Playwright screenshot + a printed DOM value (`#charBtn`, `#fps`, `#langBtn`)
* a `curl` against the live URL (`/mcp`, `/state`, `<script>` content size)
* a `node --check` on the extracted `<script>` block

Run it **before** the change. If it already passes, you are testing nothing.

## 4. Smallest change that passes

* One behaviour per edit. No drive-by refactors inside a feature patch.
* Anything added to the page must stay **dependency-free**: inline CSS, embedded SVG,
  base64 data URIs. No CDN, no audio files — the sandboxed preview has no network.
* Every new global must be declared before the first call that uses it
  (`packArrays` / `count` crashed the whole page this way once).

## 5. Verify — in this order

1. `node --check` on the script block → syntax is clean
2. headless run → **print `pageerror` before any assertion**, then the DOM values
3. screenshot → actually look at the image, do not trust the numbers
4. cycle every avatar / mode the change could have broken
5. `cp apex-humanoid.html index.html`, push, then poll the live URL until its byte size changes
   and the new marker string is present

## 6. Say what it cannot do

Every delivery ends with the honest limit: what needs a key, what needs the phone to do
something, what is only true on the free tier, what is still unproven.

---

## Commands that are used every time

```bash
# syntax
node -e "const fs=require('fs');fs.writeFileSync('/tmp/chk.js',fs.readFileSync('apex-humanoid.html','utf8').match(/<script>([\s\S]*)<\/script>/)[1]);" && node --check /tmp/chk.js

# fresh browser (the cache is dropped between sessions)
python3 -m playwright install chromium

# ship
cp apex-humanoid.html index.html
# GET sha → PUT base64 to contents/index.html (Render redeploys on its own)

# prove it
curl -s https://apexhumanoid.onrender.com/ | wc -c
curl -s https://apexhumanoid.onrender.com/state
```

## Things that have already gone wrong (do not repeat)

| Symptom | Cause | Rule |
|---|---|---|
| whole page dead, ENTER does nothing | `packArrays` / `count` used before `let` | declare globals before the first call |
| `Cannot access 'o' before initialization` | `const o = opts` below its first use | grep the variable immediately after adding it |
| avatar looks like a grey box | flat background sampled as points | cut the background or lower the luminance limit |
| deploy "succeeds" but page is old | files copied to the repo wrongly | poll the live byte size, not just the commit |
| "Publish directory does not exist" | Static Site, not Web Service | Web Service has no Publish Directory field |
