#!/bin/sh
# open-setup-page.sh <program> <data folder> <user>
#
# The first console page (m2-design.md section 9, "Opens the setup page"), run by the macOS and
# Linux installers as root, which may use the control socket as every administrator may: waits up
# to 60 s for the hub's socket, then runs `hsn open` with SUDO_USER and SUDO_UID naming the person,
# so the page opens in their own browser, unelevated, and the address is never on a command line
# (hub/cli/console-page.ts). Exits non-zero, saying why, when it cannot.
set -eu
program=$1
data=$2
user=$3
tries=0
while [ ! -S "$data/control.sock" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 60 ]; then echo "hsn-hub: the hub did not start in time" >&2; exit 1; fi
  sleep 1
done
SUDO_USER="$user" SUDO_UID="$(id -u "$user")" HSN_DATA_DIR="$data" "$program" cli open
