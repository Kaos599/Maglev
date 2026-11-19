#!/usr/bin/env bash
# On-device fault test for Maglev's link-download engine (multi-part HTTP downloads).
#
# Usage:
#   scripts/device/test-link-faults.sh [--timeout 120] [--port 8766]
#   MAGLEV_HOST_IP=192.168.1.20 ANDROID_SERIAL=XXXX scripts/device/test-link-faults.sh
#
# Needs: one phone on adb (or ANDROID_SERIAL set), screen on and unlocked, Maglev installed, and the Mac and phone on
# the same Wi-Fi. The Mac LAN IP comes from `ipconfig getifaddr en0` unless MAGLEV_HOST_IP is set.
# It starts scripts/device/faultserver.py on the Mac, drives the "Add a link" sheet through uiautomator, waits for
# each file, checks its SHA-256 against the server and prints a PASS/FAIL table. Exit 0 all pass, 1 any FAIL, 2 setup.
#
# SAFETY (the phone is a personal device). This script NEVER runs: pm clear, uninstall, install, settings, reboot,
# force-stop, or anything that touches other apps or other transfers. It only
#   - opens Maglev with a SEND intent and taps the Parts chip and Start in the sheet,
#   - reads /sdcard/Download/Maglev (ls, stat, sha256sum),
#   - deletes ONLY the file a scenario created (not present before it, name starts "<n>MB"), and only after its
#     size equals exactly n*1048576 bytes. A wrong-sized or timed-out file is left in place and reported.
# The test server is stopped on exit by a trap. With no device, or more than one and no ANDROID_SERIAL, it refuses.
set -uo pipefail

PKG="com.maglev"
DIR="/sdcard/Download/Maglev"
PORT="${MAGLEV_FAULT_PORT:-8766}"
TIMEOUT=120

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
command -v adb >/dev/null 2>&1 || { echo "adb not found on PATH" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found on PATH" >&2; exit 2; }
command -v curl >/dev/null 2>&1 || { echo "curl not found on PATH" >&2; exit 2; }
ADB=(adb)

# ---- device guard
if [ -n "${ANDROID_SERIAL:-}" ]; then
  [ "$(adb get-state 2>/dev/null | tr -d '\r')" = "device" ] || { echo "ANDROID_SERIAL=$ANDROID_SERIAL is not on adb" >&2; exit 2; }
else
  ndev=$(adb devices | tr -d '\r' | awk 'NR>1 && $2=="device"' | wc -l | tr -d ' ')
  [ "$ndev" -eq 1 ] || { echo "Need exactly one adb device, found $ndev. Set ANDROID_SERIAL to pick one." >&2; exit 2; }
fi

HOST_IP="${MAGLEV_HOST_IP:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
[ -n "$HOST_IP" ] || { echo "Cannot find the Mac LAN IP. Set MAGLEV_HOST_IP." >&2; exit 2; }

if curl -s --max-time 2 "http://127.0.0.1:$PORT/ctl/state" >/dev/null 2>&1; then
  echo "Something already answers on port $PORT. Stop it or pass --port." >&2; exit 2
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/maglev-link-faults.XXXXXX")"
LOG="$WORK/server.log"
: > "$LOG"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1; true; }
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---- helpers (python3 stdlib only)
cat > "$WORK/ui.py" <<'PY'
import re, sys
xml = sys.stdin.read()
kind, val = sys.argv[1], sys.argv[2]
for m in re.finditer(r'<node\b[^>]*>', xml):
    a = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(0)))
    if a.get(kind) == val:
        b = re.match(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]', a.get('bounds', ''))
        if b:
            x1, y1, x2, y2 = map(int, b.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
            sys.exit(0)
sys.exit(1)
PY
cat > "$WORK/stats.py" <<'PY'
# Prints: requests n429 bytes wall_seconds MBps open_ended(0/1) for one scenario's lines in the server log.
import json, re, sys
log, scen, path, size = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
rows, cur = [], False
for line in open(log):
    try:
        r = json.loads(line)
    except ValueError:
        continue
    if 'scenario' in r:
        cur = r['scenario'] == scen
        if cur:
            rows = []
        continue
    if cur and r.get('path') == path:
        rows.append(r)
ok = [r for r in rows if r.get('status') in (200, 206) and 'bytes' in r]
got = sum(r['bytes'] for r in ok)
span = (max(r['t'] + r['sec'] for r in ok) - min(r['t'] for r in ok)) if ok else 0
# A one-connection fallback asks for an open range (bytes=N-) or for no range at all.
openended = any(re.fullmatch(r'bytes=\d+-', (r.get('range') or '').strip()) or (r.get('range') is None and r.get('bytes', 0) > 1024)
                for r in ok)
print(len(rows), sum(1 for r in rows if r.get('status') == 429), got, '%.2f' % span,
      '%.2f' % (size / 1048576 / span if span > 0 else 0), int(openended))
PY

python3 -I "$HERE/faultserver.py" --port "$PORT" --log "$LOG" >"$WORK/server.out" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 20); do
  curl -s --max-time 1 "http://127.0.0.1:$PORT/ctl/state" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -s --max-time 2 "http://127.0.0.1:$PORT/ctl/state" >/dev/null 2>&1 || { echo "Fault server did not start: $(cat "$WORK/server.out")" >&2; exit 2; }

ctl() { curl -s --max-time 120 "http://127.0.0.1:$PORT/ctl/$1"; }
dump_ui() { "${ADB[@]}" exec-out uiautomator dump /dev/tty 2>/dev/null | tr -d '\r'; }

# tap_node <attr> <value> [xml]: tap the centre of the first node whose attr equals value.
tap_node() {
  local xml="${3:-$(dump_ui)}" xy
  xy=$(printf '%s' "$xml" | python3 -I "$WORK/ui.py" "$1" "$2") || return 1
  # shellcheck disable=SC2086
  "${ADB[@]}" shell input tap $xy
}

list_files() { # <n>: names starting "<n>MB", newest first, never .part
  "${ADB[@]}" shell ls -1t "$DIR" 2>/dev/null | tr -d '\r' | grep -E "^${1}MB[ .]" | grep -v '\.part$' || true
}

ROWS=()
FAILS=0
R_NOTE=""; R_VERDICT=""; R_MBPS="0"; R_REQ=0; R_429=0; R_WALL=0; R_SHA="-"; R_OPEN=0

# run_scenario <name> <mods> <MB> <parts>: sets the R_* globals.
run_scenario() {
  local name=$1 mods=$2 n=$3 parts=$4
  local path="/t/$mods/${n}MB.bin" url="http://$HOST_IP:$PORT/t/$mods/${n}MB.bin"
  local want=$((n * 1048576)) before newfile="" xml i st
  R_NOTE=""; R_VERDICT="FAIL"; R_MBPS="0"; R_REQ=0; R_429=0; R_WALL=0; R_SHA="-"; R_OPEN=0
  echo "== $name ($mods, ${n}MB, $parts part(s))"
  ctl reset >/dev/null
  printf '{"scenario":"%s"}\n' "$name" >> "$LOG"
  before=$(list_files "$n")

  "${ADB[@]}" shell input keyevent KEYCODE_WAKEUP >/dev/null 2>&1
  "${ADB[@]}" shell am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT "$url" \
    -n "$PKG/.MainActivity" >/dev/null 2>&1
  xml=""
  for i in $(seq 1 20); do
    xml=$(dump_ui)
    printf '%s' "$xml" | python3 -I "$WORK/ui.py" text Start >/dev/null && break
    xml=""; sleep 1.5
  done
  [ -n "$xml" ] || { R_NOTE="Add a link sheet (Start) not found in 30s"; return; }
  tap_node content-desc "$parts" "$xml" || { R_NOTE="Parts chip $parts not found"; return; }
  sleep 1
  tap_node text Start || { R_NOTE="Start vanished after choosing parts"; return; }
  st=$SECONDS

  local deadline=$((SECONDS + TIMEOUT)) got=0 stats
  while [ "$SECONDS" -lt "$deadline" ]; do
    stats=$(python3 -I "$WORK/stats.py" "$LOG" "$name" "$path" "$want")
    got=$(echo "$stats" | awk '{print $3}')
    if [ "${got:-0}" -ge "$want" ]; then
      newfile=$(list_files "$n" | while IFS= read -r f; do
        printf '%s\n' "$before" | grep -qxF -- "$f" || { printf '%s\n' "$f"; break; }
      done)
      [ -n "$newfile" ] && break
    fi
    sleep 1
  done
  R_WALL=$((SECONDS - st))
  stats=$(python3 -I "$WORK/stats.py" "$LOG" "$name" "$path" "$want")
  read -r R_REQ R_429 _ _ R_MBPS R_OPEN <<<"$stats"
  if [ -z "$newfile" ]; then
    R_NOTE="timed out after ${TIMEOUT}s (server sent ${got:-0}/$want bytes); transfer left in the app, cancel it by hand"
    return
  fi

  local f="$DIR/$newfile" size="" sha="" exp
  for i in 1 2 3; do
    size=$("${ADB[@]}" shell "stat -c %s '$f'" 2>/dev/null | tr -d '\r')
    [ "$size" = "$want" ] && break
    sleep 2
  done
  if [ "$size" != "$want" ]; then R_NOTE="size ${size:-?} != $want; file left in place: $newfile"; return; fi
  sha=$("${ADB[@]}" shell "sha256sum '$f'" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  exp=$(ctl "sha/$n")
  if [ -n "$sha" ] && [ "$sha" = "$exp" ]; then R_SHA="ok"; R_VERDICT="PASS"; else R_SHA="BAD"; R_NOTE="sha256 mismatch ($newfile kept)"; fi
  # Size was checked exactly above, so the file is ours and complete: delete only this one.
  [ "$R_SHA" = "ok" ] && "${ADB[@]}" shell "rm -f '$f'" >/dev/null 2>&1
}

add_row() { # <name> <parts>  (uses R_*)
  [ "$R_VERDICT" = "FAIL" ] && FAILS=$((FAILS + 1))
  ROWS+=("$(printf '%-22s %-5s %-4s %-4s %-5s %-6s %-4s %-5s %s' "$1" "$2" "$R_REQ" "$R_429" "$R_WALL" "$R_MBPS" "$R_SHA" "$R_VERDICT" "$R_NOTE")")
  echo "   -> $R_VERDICT ${R_NOTE}"
}

scenario() { # <name> <mods> <MB> <parts> [check]
  run_scenario "$1" "$2" "$3" "$4"
  if [ "$5" = "refused" ] && [ "$R_VERDICT" = "PASS" ] && [ "$R_OPEN" -eq 1 ]; then
    R_VERDICT="FAIL"; R_NOTE="fell back to one connection (open-ended Range seen)"
  fi
  add_row "$1" "$4"
}

scenario baseline    none         40 4
scenario drop        drop30       41 4
scenario short       short        42 4
scenario refused     cap3-limit2  43 4 refused
scenario plain       plain        44 4
scenario noheadrange noheadrange  45 4
scenario edge-1MB    none          1 4
scenario edge-9MB    none          9 4

# speed: 4 parts must be at least 3x faster than 1 part under a per-connection cap
run_scenario speed-1part cap3 24 1; add_row speed-1part 1; S1=$R_MBPS
run_scenario speed-4part cap3 25 4
if [ "$R_VERDICT" = "PASS" ] && ! awk -v a="$R_MBPS" -v b="$S1" 'BEGIN{exit !(b > 0 && a >= 3*b)}'; then
  R_VERDICT="FAIL"; R_NOTE="4 parts $R_MBPS MB/s is under 3x the 1-part $S1 MB/s"
fi
add_row speed-4part 4

echo
printf '%-22s %-5s %-4s %-4s %-5s %-6s %-4s %-5s %s\n' scenario parts reqs 429s wall_s MB/s sha verdict note
for r in "${ROWS[@]}"; do echo "$r"; done
echo
echo "Server log: $LOG"
if [ "$FAILS" -gt 0 ]; then echo "$FAILS scenario(s) FAILED"; exit 1; fi
echo "All scenarios passed"
