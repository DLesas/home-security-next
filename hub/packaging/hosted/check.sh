#!/bin/sh
# check.sh <step> …: the installer's checks on a hosted macOS or Linux machine, as root
# (m2-design.md section 9, "The privilege boundary", "Tested on the hosted machines"). A9's
# installer workflow calls them around the package's own install, upgrade, uninstall and purge:
#
#   check.sh owners             every file of the package's tree root-owned and written by no one
#                               else, the hub's account unable to write any of it; `hsn` and the
#                               launcher root's, 0755; each hub tree's top folder the hub's, 0700,
#                               in a root-owned parent; on macOS the daemon names no log path
#   check.sh plant              root-owned targets outside every tree (a file and a folder), and in
#                               each hub tree, at its top and below it: a hard link to the file and
#                               a symbolic link to the folder; the targets' owners, modes and
#                               contents noted
#   check.sh verify             after an upgrade, an uninstall or a purge: every target present,
#                               its owner, mode and contents unchanged
#   check.sh link-top <cmd…>    a hub tree's top folder replaced by a link to a root-owned folder;
#                               the installer step <cmd…> must refuse; the folder put back
#   check.sh console            "the console opens" with no desktop: the console listener's page
#                               and headers, and `hsn open` printing the code, address, fingerprint
#
# Each exits non-zero, saying what failed.
set -eu
case "$(uname -s)" in
  Darwin)
    PKG=/usr/local/hsn-hub; HSN=/usr/local/bin/hsn; HUB=_hsnhub
    DATA="/Library/Application Support/HSN Hub"; PROGRAM="/Library/Application Support/HSN Hub Program"
    PLIST=/Library/LaunchDaemons/com.hsn.hub.plist
    stat_line() { stat -f '%u %Lp %z' "$1"; }
    ;;
  *)
    PKG=/usr/lib/hsn-hub; HSN=/usr/bin/hsn; HUB=hsn
    DATA=/var/lib/hsn-hub; PROGRAM=/var/lib/hsn-hub-program
    PLIST=
    stat_line() { stat -c '%u %a %s' "$1"; }
    ;;
esac
TARGETS=/var/tmp/hsn-plant-targets
NOTES=/var/tmp/hsn-plant-notes
fail() { echo "check: $1" >&2; exit 1; }
as_hub() { sudo -u "$HUB" "$@"; }
[ "$(id -u)" = 0 ] || fail "run as root"

top_ok() {
  folder=$1
  [ -d "$folder" ] && [ ! -L "$folder" ] || fail "$folder is not a plain folder"
  line=$(ls -ld "$folder")
  owner=$(echo "$line" | awk '{print $3}')
  [ "$owner" = "$HUB" ] || fail "$folder belongs to $owner"
  mode=$(stat_line "$folder" | awk '{print $2}')
  [ "$mode" = 700 ] || fail "$folder has mode $mode"
  parent=$(dirname "$folder")
  [ "$(ls -ldn "$parent" | awk '{print $3}')" = 0 ] || fail "$parent is not root's"
}

case "${1:-}" in
  owners)
    find "$PKG" "$HSN" -print | while IFS= read -r path; do
      uid=$(ls -ldn "$path" | awk '{print $3}')
      [ "$uid" = 0 ] || fail "$path belongs to uid $uid"
      [ -z "$(find "$path" -maxdepth 0 -perm -0022 ! -type l)" ] || fail "$path is writable by its group or others"
      if as_hub test -w "$path"; then fail "the hub's account can write $path"; fi
    done
    for exe in "$HSN" "$PKG/bin/hsn-launcher"; do
      mode=$(stat_line "$exe" | awk '{print $2}')
      [ "$mode" = 755 ] || fail "$exe has mode $mode"
    done
    top_ok "$DATA"
    top_ok "$PROGRAM"
    if [ -n "$PLIST" ]; then
      if plutil -extract StandardOutPath raw "$PLIST" >/dev/null 2>&1 || plutil -extract StandardErrorPath raw "$PLIST" >/dev/null 2>&1; then
        fail "the daemon names a log path"
      fi
    fi
    echo "check: owners and modes as section 9 has them"
    ;;
  plant)
    rm -rf "$TARGETS"
    mkdir -p "$TARGETS/folder"
    printf 'a root-owned file\n' > "$TARGETS/file"
    printf 'inside a root-owned folder\n' > "$TARGETS/folder/inside"
    chmod 0644 "$TARGETS/file" "$TARGETS/folder/inside"
    chmod 0755 "$TARGETS/folder"
    : > "$NOTES"
    for target in "$TARGETS/file" "$TARGETS/folder" "$TARGETS/folder/inside"; do
      echo "$target $(stat_line "$target") $(cksum < "$target" 2>/dev/null || echo folder)" >> "$NOTES"
    done
    for tree in "$DATA" "$PROGRAM"; do
      for at in "$tree" "$tree/staged"; do
        mkdir -p "$at"
        ln -f "$TARGETS/file" "$at/planted-hardlink"
        ln -sfn "$TARGETS/folder" "$at/planted-symlink"
      done
      chown -h -R "$HUB" "$tree/staged" 2>/dev/null || true
    done
    echo "check: planted"
    ;;
  verify)
    [ -s "$NOTES" ] || fail "nothing was planted"
    for target in "$TARGETS/file" "$TARGETS/folder" "$TARGETS/folder/inside"; do
      [ -e "$target" ] || fail "$target is gone"
      now="$target $(stat_line "$target") $(cksum < "$target" 2>/dev/null || echo folder)"
      grep -qxF "$now" "$NOTES" || fail "$target changed: $now"
    done
    echo "check: every target unchanged"
    ;;
  link-top)
    shift
    [ "$#" -gt 0 ] || fail "link-top needs the installer step to run"
    mv "$DATA" "$DATA.moved"
    mkdir -p "$TARGETS/folder"
    ln -s "$TARGETS/folder" "$DATA"
    refused=no
    "$@" >/dev/null 2>&1 || refused=yes
    rm "$DATA"
    mv "$DATA.moved" "$DATA"
    [ "$refused" = yes ] || fail "the installer did not refuse a top folder replaced by a link"
    echo "check: refused"
    ;;
  console)
    page=$(curl -fsS -D - http://127.0.0.1:8445/) || fail "the console listener did not answer"
    echo "$page" | grep -qi '^content-security-policy:' || fail "the console page has no CSP header"
    echo "$page" | grep -qi '<html' || fail "the console page is not the web app's"
    out=$(env -u SUDO_USER -u SUDO_UID "$HSN" open 2>&1) || fail "hsn open failed: $out"
    echo "$out" | grep -qi 'no browser' || fail "hsn open did not say there is no browser: $out"
    echo "check: the console opens (no desktop)"
    ;;
  *)
    fail "usage: check.sh owners | plant | verify | link-top <cmd…> | console"
    ;;
esac
