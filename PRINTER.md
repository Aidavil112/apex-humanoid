# 3D printer bridge (already built, needs hardware)

The humanoid can read and drive a 3D printer over HTTP. The code is in `server.js`
and live on the free Render service — it just needs a printer to talk to.

## What exists right now (works with nothing configured)

| Route | What it does |
|---|---|
| `GET /printer` | state, current file, progress, time left |
| `POST /printer/start` `{ "file": "benchy.gcode" }` | selects the file already **on the printer** and starts it |
| `POST /printer/stop` | cancels the job |

Telegram: `/printer` · `/print benchy.gcode` · `/stopprinter`
MCP tools: `printer_status`, `printer_start`, `printer_stop`
Voice: say anything with "printer" / "print" / "3d" → the page answers from `/printer`.

With no printer configured every call answers:
`{"configured": false, "hint": "Render > Environment > OCTOPRINT_URL = http://your-printer-ip"}`

## What you need (hardware, not software)

1. A printer running **OctoPrint** (Raspberry Pi, or the printer's own built-in OctoPrint)
   or **Klipper + Moonraker**.
2. A way for Render to reach it. Render is on the public internet, the printer is on your
   home Wi-Fi — so one of:
   * **Tailscale** on the Pi + a Tailscale sidecar (paid-tier feature on Render, avoid), or
   * a **Cloudflare Tunnel** on the Pi → gives a public `https://xxx.trycloudflare.com` URL, or
   * run the bridge on the Pi itself (`node server.js` there) and keep Render only for the page.
3. A **camera** outside the printer if you want the humanoid to *see* the print — not built.

## Env variables

```
OCTOPRINT_URL     http://192.168.1.50        (no trailing slash)
OCTOPRINT_API_KEY the API key from OctoPrint > Settings > API
PRINTER_KIND      octoprint | moonraker      (default: octoprint)
```

## Honest limits

* The file must already be on the printer (upload is not implemented).
* No pre-flight checks. **Do not point this at a printer with a hot nozzle and let a
  language model start jobs** — the voice path only reports status, but `/print` from
  Telegram/MCP starts a real job.
* No camera, no failure detection, no filament sensor.
* Free Render sleeps after 15 min idle — a scheduled print will not start while asleep.
