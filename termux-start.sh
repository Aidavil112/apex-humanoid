#!/data/data/com.termux/files/usr/bin/bash
# APEX Humanoid — Termux one-shot starter
# Usage:  bash termux-start.sh          (starts / restarts)
#         bash termux-start.sh logs     (shows the log)
#         bash termux-start.sh stop     (stops it)
set -u
DIR="$HOME/apex-humanoid"
ENVF="$HOME/.apex_env"
LOG="$HOME/apex.log"
PORT_NUM=8787

say(){ printf '\033[36m%s\033[0m\n' "$*"; }
bad(){ printf '\033[31m%s\033[0m\n' "$*"; }

case "${1:-start}" in
  stop)
    pkill -f "node server.js" 2>/dev/null && say "stopped" || say "nothing was running"
    exit 0 ;;
  logs)
    [ -f "$LOG" ] && tail -n 40 "$LOG" || bad "no log yet — run: bash termux-start.sh"
    exit 0 ;;
esac

# 1. packages
need=0
command -v node >/dev/null || need=1
command -v git  >/dev/null || need=1
if [ "$need" = 1 ]; then
  say "installing nodejs + git (first time, ~1 min)…"
  pkg update -y >/dev/null 2>&1
  pkg install -y nodejs git || { bad "pkg install failed — internet check karo"; exit 1; }
fi

# 2. code
if [ -d "$DIR/.git" ]; then
  say "updating code…"
  ( cd "$DIR" && git pull --ff-only >/dev/null 2>&1 ) || say "update skipped (offline?)"
else
  say "downloading code…"
  git clone --depth 1 https://github.com/Aidavil112/apex-humanoid "$DIR" || {
    bad "clone failed — internet check karo"; exit 1; }
fi
cd "$DIR" || exit 1

# 3. api key (asked once, saved)
if [ ! -f "$ENVF" ] || ! grep -q GEMINI_API_KEY "$ENVF"; then
  say "Paste your Gemini API key (AI Studio wali, AQ. se shuru) then press ENTER:"
  read -r KEY
  printf 'GEMINI_API_KEY=%s\n' "$KEY" > "$ENVF"
  chmod 600 "$ENVF"
fi
. "$ENVF"

# 4. stop an old copy, start a fresh one
pkill -f "node server.js" 2>/dev/null
sleep 1
export PORT="$PORT_NUM"
: > "$LOG"
nohup node server.js >> "$LOG" 2>&1 &
command -v termux-wake-lock >/dev/null && termux-wake-lock 2>/dev/null

# 5. prove it is alive
for i in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT_NUM/health" >/dev/null 2>&1; then
    say ""
    say "✅ chal raha hai —"
    say "   Chrome me kholo:  http://localhost:$PORT_NUM"
    exit 0
  fi
done

bad "server start nahi hua. Log:"
tail -n 25 "$LOG"
exit 1
