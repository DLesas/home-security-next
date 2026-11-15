#!/bin/sh
# sudo uninstall.sh [--purge]: removes the daemon, the program and `hsn`, and keeps the data folder
# unless --purge is given (m2-design.md section 9, "Uninstalling"); --purge also removes the user.
set -eu
launchctl bootout system/com.hsn.hub 2>/dev/null || true
rm -f /Library/LaunchDaemons/com.hsn.hub.plist /usr/local/bin/hsn
rm -rf /usr/local/hsn-hub /usr/local/libexec/hsn-hub
pkgutil --forget com.hsn.hub >/dev/null 2>&1 || true
if [ "${1:-}" = "--purge" ]; then
  rm -rf "/Library/Application Support/HSN Hub" "/Library/Logs/HSN Hub"
  dscl . -delete /Users/_hsnhub 2>/dev/null || true
  dscl . -delete /Groups/_hsnhub 2>/dev/null || true
fi
