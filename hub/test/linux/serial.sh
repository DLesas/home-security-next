#!/bin/sh
# The serial tests on Linux (the Raspberry Pi's system), in Bun's own Debian image: the hub's
# byte-clean terminal settings, `closeTty` letting go at once (O_NONBLOCK and a wake, section 3),
# and everything else in the two serial test files, over real pseudo-terminals.
#
#   sh hub/test/linux/serial.sh            (or: bun run check:serial-linux)
#
# The repository is mounted read-only and the container has no network. `serialport`'s native
# add-on is built for this machine, not the container, and only lists ports, so the copy the
# tests run on has its import stubbed. Skipped, with a message, without docker or the image.
set -eu
IMAGE="${HSN_LINUX_IMAGE:-oven/bun:1.4.2-debian}"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "skipped: docker is not installed (the Linux serial tests run in $IMAGE)"
  exit 0
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "skipped: the image $IMAGE is not here (docker pull $IMAGE, then run this again)"
  exit 0
fi

docker run --rm --network none -v "$ROOT:/repo:ro" "$IMAGE" sh -euc '
  mkdir -p /tmp/hub
  cp -r /repo/hub/src /repo/hub/test /tmp/hub/
  ln -s /repo/hub/node_modules /tmp/hub/node_modules
  sed -i "s#^import { SerialPort } from \"serialport\";#const SerialPort = { list: async () => [] };#" \
    /tmp/hub/src/shell/safe/serial.ts
  cd /tmp/hub
  bun --version
  bun test test/unit/shell-links/serial.test.ts test/unit/shell-links/serial-clean.test.ts
'
