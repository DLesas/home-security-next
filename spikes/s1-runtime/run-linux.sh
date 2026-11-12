#!/bin/bash
# Runs inside a node:26 container: installs, builds, measures Node and Bun. Usage: run-linux.sh <label>
set -e
LABEL=$1
mkdir -p /work && cd /src && cp -r package.json package-lock.json build.mjs measure.mjs ccm-vectors.ts src /work/ && cd /work
npm install --no-fund --no-audit >/tmp/npm.log 2>&1 || { tail -20 /tmp/npm.log; exit 1; }
npm install -g bun@1.4.4 >/tmp/bun.log 2>&1 || { tail -20 /tmp/bun.log; exit 1; }
echo "node $(node -v), bun $(bun -v), $(uname -m)"
node build.mjs
bun build src/bun.ts --target=bun --outfile dist/bun.mjs --external serialport --external onnxruntime-node --external webgpu >/dev/null
bun build src/bun.ts --compile --outfile dist/hub-bun >/dev/null
echo "SIZES"
echo "node binary $(stat -c %s $(readlink -f $(which node)))"
echo "bun binary $(stat -c %s $(readlink -f $(which bun)))"
echo "bun single executable $(stat -c %s dist/hub-bun)"
echo "node bundle $(stat -c %s dist/node.mjs)"
echo "bun bundle $(stat -c %s dist/bun.mjs)"
node ccm-vectors.ts && bun ccm-vectors.ts
node measure.mjs '[{"name":"Node 26, bundled JS","cmd":"node","args":["dist/node.mjs"]},{"name":"Bun 1.4.4, bundled JS","cmd":"bun","args":["dist/bun.mjs"]},{"name":"Bun 1.4.4, single executable","cmd":"./dist/hub-bun","args":[]}]' /out/results-$LABEL.json
