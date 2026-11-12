#!/usr/bin/env bash
# Repeatable on-device performance snapshot for Maglev. Run the same script before and after a change.
#
#   scripts/perf/measure.sh <label> [runs]
#
# Needs one Android device on adb with Maglev installed. Measures:
#   - cold start: `am start -W` TotalTime over <runs> launches (the app is force-stopped before each, never cleared)
#   - Transfers scroll: frames, janky %, 50/90/95/99th percentile frame time (dumpsys gfxinfo)
#   - Search scroll: the same, after a deep-link search for a small public title
#   - idle JS and UI thread CPU on Transfers over 10 s (top -H)
#   - memory: total PSS after the run
# Writes scripts/perf/out/<label>-<time>.json (ignored by git) and prints a summary.
set -euo pipefail

LABEL=${1:?usage: measure.sh <label> [runs]}
RUNS=${2:-5}
PKG=com.maglev
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/${LABEL}-$(date +%Y%m%d-%H%M%S).json"

adb get-state >/dev/null 2>&1 || { echo "No device on adb. Connect the phone and allow USB debugging."; exit 1; }
ACT=$(adb shell cmd package resolve-activity --brief "$PKG" | tail -1 | tr -d '\r')
VERSION=$(adb shell dumpsys package "$PKG" | sed -n 's/.*versionName=\([^ ]*\).*/\1/p' | head -1 | tr -d '\r')
SIZE=$(adb shell wm size | sed -n 's/.*: \([0-9]*\)x\([0-9]*\).*/\1 \2/p' | tail -1 | tr -d '\r')
W=${SIZE% *}; H=${SIZE#* }
X=$((W / 2)); YT=$((H * 3 / 10)); YB=$((H * 8 / 10))

echo "Maglev $VERSION on $(adb shell getprop ro.product.model | tr -d '\r'), $RUNS cold starts"

# ---- cold start
starts=()
for i in $(seq 1 "$RUNS"); do
  adb shell am force-stop "$PKG"
  sleep 2
  t=$(adb shell am start -W -n "$ACT" | sed -n 's/TotalTime: //p' | tr -d '\r')
  starts+=("$t")
  sleep 4
done

# ---- scroll helper: reset gfxinfo, fling up and down, read the summary
scroll() {
  adb shell dumpsys gfxinfo "$PKG" reset >/dev/null
  for _ in 1 2 3 4 5 6; do
    adb shell input swipe "$X" "$YB" "$X" "$YT" 120
    sleep 0.4
    adb shell input swipe "$X" "$YT" "$X" "$YB" 120
    sleep 0.4
  done
  adb shell dumpsys gfxinfo "$PKG" | tr -d '\r' | awk '
    /Total frames rendered/ {f=$4}
    /Janky frames:/ && !j {j=$3; jp=$4}
    /^50th percentile/ && !p50 {p50=$3}
    /^90th percentile/ && !p90 {p90=$3}
    /^95th percentile/ && !p95 {p95=$3}
    /^99th percentile/ && !p99 {p99=$3}
    END {gsub(/[()%]/,"",jp); printf "{\"frames\":%s,\"janky\":%s,\"janky_pct\":%s,\"p50\":\"%s\",\"p90\":\"%s\",\"p95\":\"%s\",\"p99\":\"%s\"}", f+0, j+0, jp+0, p50, p90, p95, p99}'
}

# ---- Transfers (the first tab after launch)
adb shell am start -W -n "$ACT" >/dev/null
sleep 3
transfers=$(scroll)

# ---- idle thread CPU on Transfers, 10 s window
PID=$(adb shell pidof "$PKG" | tr -d '\r')
idle=$(adb shell top -H -b -d 10 -n 2 -p "$PID" | tr -d '\r' | awk '
  /^Tasks:/ {n++}
  n==2 && /mqt_v_js|mqt_js/ {js+=$9}
  n==2 && $NF ~ /^com.maglev$|RenderThread/ {ui+=$9}
  END {printf "{\"js_cpu_pct\":%.1f,\"ui_render_cpu_pct\":%.1f}", js, ui}')

# ---- Search: deep link a small public-domain title, wait for sources, scroll the results
adb shell am start -W -a android.intent.action.VIEW -d "maglev://search?q=big%20buck%20bunny" "$PKG" >/dev/null
sleep 10
search=$(scroll)

# ---- memory
pss=$(adb shell dumpsys meminfo "$PKG" | tr -d '\r' | awk '/TOTAL PSS:/ {print $3; exit} /^ *TOTAL / {print $2; exit}')

starts_json=$(printf '%s,' "${starts[@]}"); starts_json="[${starts_json%,}]"
median=$(printf '%s\n' "${starts[@]}" | sort -n | awk '{a[NR]=$1} END {print a[int((NR+1)/2)]}')

cat > "$OUT" <<JSON
{"label":"$LABEL","version":"$VERSION","cold_start_ms":$starts_json,"cold_start_median_ms":$median,
 "transfers_scroll":$transfers,"search_scroll":$search,"idle_transfers":$idle,"total_pss_kb":${pss:-0}}
JSON

echo "cold start median ${median} ms  (runs: ${starts[*]})"
echo "transfers scroll  $transfers"
echo "search scroll     $search"
echo "idle on Transfers $idle"
echo "total PSS         ${pss:-?} KB"
echo "saved $OUT"
