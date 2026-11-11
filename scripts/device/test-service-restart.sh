#!/usr/bin/env bash
# C-SVC-3 device check (docs/NATIVE_CONTRACT.md section 11.7): the foreground service must come back after a crash.
#
# Usage:
#   scripts/device/test-service-restart.sh [--serial SERIAL] [--package com.maglev] [--timeout 60]
#
# Prerequisites: adb on PATH, one device or emulator, a debuggable or `adb shell am crash`-able Maglev build installed.
# Two runs, each prepared by hand:
#   1. With a torrent DOWNLOADING:            the script crashes the app, then asserts that the service is back and the
#                                             download moves again (expects exit 0).
#   2. With every torrent paused by the user: pass --expect-stopped. The service must stay stopped after the crash.
#
# Exit codes: 0 pass, 1 assertion failed, 2 usage or adb problem.
set -euo pipefail

PKG="com.maglev"
TIMEOUT=60
SERIAL=""
EXPECT_STOPPED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --serial) SERIAL="$2"; shift 2 ;;
    --package) PKG="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    --expect-stopped) EXPECT_STOPPED=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v adb >/dev/null 2>&1 || { echo "adb not found on PATH" >&2; exit 2; }
ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")
"${ADB[@]}" get-state >/dev/null 2>&1 || { echo "No device found (adb get-state failed)" >&2; exit 2; }

SERVICE="MaglevTorrentService"

service_running() {
  # `dumpsys activity services <pkg>` lists ServiceRecords of the package while they exist.
  # Capture first: `grep -q` closing the pipe early would trip pipefail.
  local out
  out=$("${ADB[@]}" shell dumpsys activity services "$PKG" 2>/dev/null | tr -d '\r' || true)
  grep -q "$SERVICE" <<<"$out"
}

# A moving download shows in the ongoing notification text as a rate such as "↓ 1.2 MB/s".
download_moving() {
  local out
  out=$("${ADB[@]}" shell dumpsys notification --noredact 2>/dev/null | tr -d '\r' | grep -A40 "pkg=$PKG" || true)
  grep -Eq '↓ [0-9.]+ (B|KB|MB|GB)/s' <<<"$out"
}

echo "Package: $PKG, timeout: ${TIMEOUT}s"
if [ "$EXPECT_STOPPED" -eq 0 ]; then
  service_running || { echo "FAIL precondition: service is not running. Start a download first." >&2; exit 1; }
fi

PID_BEFORE=$("${ADB[@]}" shell pidof "$PKG" | tr -d '\r' || true)
echo "Crashing $PKG (pid ${PID_BEFORE:-none})"
"${ADB[@]}" shell am crash "$PKG"

if [ "$EXPECT_STOPPED" -eq 1 ]; then
  # Give Android time to restart a sticky service, then confirm nothing came back.
  sleep 20
  if service_running; then
    echo "FAIL: service restarted although the user had paused everything" >&2
    exit 1
  fi
  echo "PASS: service stayed stopped"
  exit 0
fi

deadline=$((SECONDS + TIMEOUT))
back=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if service_running; then back=1; break; fi
  sleep 2
done
if [ "$back" -ne 1 ]; then
  echo "FAIL: service did not come back within ${TIMEOUT}s" >&2
  exit 1
fi
echo "Service is back after $((SECONDS - (deadline - TIMEOUT)))s"

moving=0
while [ "$SECONDS" -lt "$deadline" ]; do
  if download_moving; then moving=1; break; fi
  sleep 2
done
if [ "$moving" -ne 1 ]; then
  echo "FAIL: service is back but no download speed shown in the notification within ${TIMEOUT}s" >&2
  exit 1
fi
echo "PASS: service restarted and the download is moving"
