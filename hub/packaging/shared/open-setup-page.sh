#!/bin/sh
# open-setup-page.sh <hsn> [<user>]
#
# The first console page after a fresh install (m2-design.md section 9, "Opens the setup page",
# "The console opens" with no desktop), run by the macOS and Linux installers as root through the
# package's own root-owned `hsn`, never the hub's program: it waits up to 60 s for the hub to
# answer `hsn status`, then runs `hsn open`. With a person named, SUDO_USER and SUDO_UID say who,
# so the page opens in their own browser, unelevated, and the address is never on a command line;
# with none (no desktop session), `hsn open` says there is no browser to open and prints the
# first linking code, the home-network address and the certificate's fingerprint. Its own failure
# is said, never hidden, and its exit code is `hsn`'s.
set -eu
hsn=$1
user=${2:-}
tries=0
until "$hsn" status >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then
    echo "hsn-hub: the hub did not answer within 60 s; run \`sudo hsn status\`, then \`sudo hsn open\`" >&2
    exit 1
  fi
  sleep 1
done
if [ -n "$user" ] && [ "$user" != root ]; then
  SUDO_USER="$user" SUDO_UID="$(id -u "$user")" exec "$hsn" open
fi
env -u SUDO_USER -u SUDO_UID "$hsn" open
