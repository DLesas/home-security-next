#!/bin/zsh
# The bridge's smoke run on one simulator (checklist step 2). Usage: app/e2e-native/smoke.sh ios|android
# Starts the Bluetooth bench with its smoke boards on 127.0.0.1:8787, opens its /smoke page in the
# simulator's browser (Android: through `adb reverse`, so the emulator's 127.0.0.1:8787 is the
# Mac's), waits for the page's verdict, prints it and stops the bench. The page pairs a scripted
# siren with Security 2 and updates a scripted sensor, through the same client a
# development build bundles. Nothing listens beyond the Mac's loopback.
set -u
PLATFORM=${1:-ios}
REPO=${0:A:h:h:h}
LOG=$(mktemp -t ble-bench-smoke)
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export PATH=$ANDROID_HOME/platform-tools:$PATH
# The bench reads commands on standard input; a pipe that stays open keeps it running.
( tail -f /dev/null | bun "$REPO/tools/ble-bench/src/bridge/main.ts" --port 8787 --smoke > "$LOG" 2>&1 ) &
BENCH=$!
until grep -q '"kind":"ready"' "$LOG" 2>/dev/null; do sleep 0.5; done
if [ "$PLATFORM" = "android" ]; then
  adb reverse tcp:8787 tcp:8787
  adb shell am start -a android.intent.action.VIEW -d "http://127.0.0.1:8787/smoke" > /dev/null
else
  xcrun simctl openurl booted "http://127.0.0.1:8787/smoke"
fi
for i in $(seq 1 120); do grep -q '"kind":"smoke"' "$LOG" && break; sleep 1; done
grep '"kind":"smoke"\|"kind":"problem"' "$LOG" || echo '{"kind":"smoke","pass":false,"lines":["no verdict in 120 s"]}'
pkill -P $BENCH 2>/dev/null; kill $BENCH 2>/dev/null
pkill -f "ble-bench/src/bridge/main.ts --port 8787 --smoke" 2>/dev/null
grep -q '"pass":true' "$LOG"
