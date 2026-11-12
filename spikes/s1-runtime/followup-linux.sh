#!/bin/bash
# Follow-up inside the container: serial listing with udev present, and repeated starts of the Bun executable.
set -e
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq udev >/dev/null 2>&1
mkdir -p /work && cd /src && cp -r package.json package-lock.json build.mjs src /work/ && cd /work
npm install --no-fund --no-audit >/tmp/npm.log 2>&1 && npm install -g bun@1.4.4 >/tmp/bun.log 2>&1
echo "$(uname -m)"
cat > serial.mjs <<'JS'
import { SerialPort } from "serialport";
const ports = await SerialPort.list();
console.log(`${typeof Bun !== "undefined" ? "Bun" : "Node"}: serialport binding loaded, ${ports.length} port(s)`);
JS
node serial.mjs || true
bun serial.mjs || true
bun build src/bun.ts --compile --outfile dist/hub-bun >/dev/null
fails=0
for i in $(seq 1 20); do
  PORT=$((46000+i)) ./dist/hub-bun 2>/tmp/err-$i.log &
  pid=$!
  sleep 0.6
  if ! kill -0 $pid 2>/dev/null; then fails=$((fails+1)); echo "start $i failed:"; grep -m3 -iE "error|panic|EADDR" /tmp/err-$i.log || tail -3 /tmp/err-$i.log; else kill -9 $pid; fi
done
echo "Bun single executable: $fails of 20 starts failed"
