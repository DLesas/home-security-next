#!/bin/sh
# sudo hsn uninstall [--remove-data] [--yes] (m2-design.md section 9, "Uninstalling" and "The
# privilege boundary"): the daemon stopped, the package's tree, `hsn` and the daemon's definition
# removed; the hub's two trees kept, unless --remove-data, which asks first (or takes --yes, for a
# script): then, with every process of the hub's user ended, each hub tree removed whole by
# macOS `rm -rf`, which removes a link as a link and never follows one, and the user removed.
set -eu
USER_NAME=_hsnhub
DATA="/Library/Application Support/HSN Hub"
PROGRAM="/Library/Application Support/HSN Hub Program"
remove_data=no
yes=no
for word in "$@"; do
  case "$word" in
    --remove-data) remove_data=yes ;;
    --yes) yes=yes ;;
    *) echo "usage: sudo hsn uninstall [--remove-data] [--yes]" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "hsn uninstall: run it with sudo" >&2; exit 1; }
if [ "$remove_data" = yes ] && [ "$yes" != yes ]; then
  echo "This removes HSN Hub and all its data: every person, phone and setting, and every"
  echo "device's key, so each device must be paired again. It cannot be undone."
  printf 'Type "remove" to go on: '
  read -r answer </dev/tty || answer=""
  [ "$answer" = remove ] || { echo "Nothing was removed."; exit 1; }
fi
launchctl bootout system/com.hsn.hub 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.hsn.hub.plist /usr/local/bin/hsn
rm -rf /usr/local/hsn-hub
pkgutil --forget com.hsn.hub >/dev/null 2>&1 || true
[ "$remove_data" = yes ] || { echo "HSN Hub removed; its data is kept in $DATA."; exit 0; }
tries=0
while pgrep -u "$USER_NAME" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 30 ]; then echo "hsn uninstall: the hub's processes did not end; its data is kept" >&2; exit 1; fi
  sleep 1
done
rm -rf "$DATA" "$PROGRAM"
dscl . -delete "/Users/$USER_NAME" 2>/dev/null || true
dscl . -delete "/Groups/$USER_NAME" 2>/dev/null || true
echo "HSN Hub and its data removed."
