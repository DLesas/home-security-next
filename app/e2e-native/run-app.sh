#!/bin/zsh
# Starts Metro for the development build with the bench's bridge address, carries the ports to the
# Android emulator, and builds (incrementally), installs and starts the app, in the form of the
# earlier phone engineers' run scripts (P0b's ios-run.sh and android-run.sh).
# Usage: app/e2e-native/run-app.sh ios|android [metro port, 8081] [--clear]
#
# EXPO_PUBLIC_HSN_BLE_BENCH=ws://127.0.0.1:8787 is read by Metro when it bundles; P4's selector in
# app/src/platform/ble.native.ts uses `bridgeBleCentral` in place of react-native-ble-plx only under __DEV__ and
# only when it is set (tools/ble-bench/README.md). On Android, `adb reverse` makes the emulator's
# 127.0.0.1:8787 the Mac's, so the same address serves both. Start the harness first
# (`bun app/e2e-native/harness.ts`), which runs the bench on 8787.
set -u
BRIDGE_PORT=${HSN_P4_BRIDGE_PORT:-8787}
PLATFORM=${1:-ios}
PORT=${2:-8081}
METRO_FLAGS=()
if [[ "$PORT" == "--clear" ]]; then
  PORT=8081
  METRO_FLAGS=(--clear)
elif [[ "${3:-}" == "--clear" ]]; then
  METRO_FLAGS=(--clear)
fi
APP=${0:A:h:h}
LOG=$(mktemp -t metro-native)
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export PATH=$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH
cd "$APP"
CI=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 EXPO_PUBLIC_HSN_BLE_BENCH="ws://127.0.0.1:$BRIDGE_PORT" \
  node_modules/.bin/expo start --port "$PORT" "${METRO_FLAGS[@]}" > "$LOG" 2>&1 &
until curl -s "http://127.0.0.1:$PORT/status" | grep -q running; do sleep 1; done
echo "Metro on $PORT, log $LOG"
if [ "$PLATFORM" = "android" ]; then
  adb reverse tcp:8081 tcp:"$PORT"
  adb reverse tcp:"$BRIDGE_PORT" tcp:"$BRIDGE_PORT"
  CI=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 node_modules/.bin/expo run:android --no-bundler --port "$PORT"
else
  CI=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 node_modules/.bin/expo run:ios --no-bundler --port "$PORT"
fi
