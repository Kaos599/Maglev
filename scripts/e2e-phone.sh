#!/usr/bin/env bash
# Run the Maestro flows in .maestro/ on a physical Android device (or emulator).
# WARNING: flows clear the app's data and delete downloads on that device.
# Usage: scripts/e2e-phone.sh   (device: $ANDROID_SERIAL, else first `adb devices` entry)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export PATH="$HOME/.maestro/bin:$PATH"
command -v maestro >/dev/null 2>&1 || { echo "maestro not found. Install: curl -fsSL https://get.maestro.mobile.dev | bash" >&2; exit 2; }
command -v adb >/dev/null 2>&1 || { echo "adb not found on PATH" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found on PATH" >&2; exit 2; }

DEVICE="${ANDROID_SERIAL:-}"
if [ -z "$DEVICE" ]; then
  DEVICE="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
fi
if [ -z "$DEVICE" ]; then
  echo "No Android device found. Connect one and check 'adb devices'." >&2
  exit 2
fi
echo "Device: $DEVICE"

OUT="$ROOT/e2e-out"
rm -rf "$OUT"
mkdir -p "$OUT"

set +e
maestro test .maestro/ --device "$DEVICE" --format JUNIT --output "$OUT/report.xml" --test-output-dir "$OUT/"
RC=$?
set -e

if [ ! -f "$OUT/report.xml" ]; then
  echo "Maestro produced no report (exit $RC)." >&2
  exit 1
fi

python3 - "$OUT/report.xml" "$OUT" <<'PY'
import sys, glob, os
import xml.etree.ElementTree as ET

report, out = sys.argv[1], sys.argv[2]
root = ET.parse(report).getroot()
suites = [root] if root.tag == "testsuite" else root.findall("testsuite")
failed_any = False
print()
print(f"{'FLOW':<22} RESULT")
for suite in suites:
    for case in suite.iter("testcase"):
        name = case.get("name") or "?"
        fail = case.find("failure")
        if fail is None:
            fail = case.find("error")
        if fail is None:
            print(f"{name:<22} PASS")
            continue
        failed_any = True
        msg = (fail.get("message") or "").strip().splitlines()
        msg = msg[0] if msg else "failed"
        print(f"{name:<22} FAIL  {msg[:200]}")
        # Failing step and screenshot, if Maestro recorded them.
        # Maestro writes <out>/<run-timestamp>/<flow>/screenshots/step-NNN-*.png
        shots = sorted(glob.glob(os.path.join(out, "*", name, "screenshots", "*.png")))
        for s in shots[-1:]:
            print(f"{'':<22} screenshot: {os.path.abspath(s)}")
        step = (fail.text or "").strip().splitlines()
        if step:
            print(f"{'':<22} at: {step[0][:200]}")
print()
print(f"Report: {os.path.abspath(report)}")
sys.exit(1 if failed_any else 0)
PY
PY_RC=$?

if [ "$RC" -ne 0 ] || [ "$PY_RC" -ne 0 ]; then
  exit 1
fi
