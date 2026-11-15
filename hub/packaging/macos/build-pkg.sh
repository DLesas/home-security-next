#!/bin/sh
# build-pkg.sh <out folder> [<program folder>]
#
# Builds HSN-Hub-<version>.pkg (m2-design.md section 9, macOS), unsigned until the developer
# account comes with M4 (D119): the person approves it in the system's security settings. On a Mac
# of the target's architecture with Bun and the web app exported (`bun run app:export`); pkgbuild
# is the system's own. A <program folder> already built by build-program.ts may be given.
set -eu
out=$1
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
program=${2:-}
if [ -z "$program" ]; then
  case "$(uname -m)" in
    arm64) target=bun-darwin-arm64 ;;
    *) target=bun-darwin-x64 ;;
  esac
  program="$work/program"
  bun "$repo/hub/packaging/shared/build-program.ts" --target "$target" --out "$program" >/dev/null
fi
version=$(cat "$program/version")
root="$work/root"
mkdir -p "$root/usr/local/hsn-hub/versions" "$root/usr/local/libexec/hsn-hub" "$root/usr/local/bin" "$root/Library/LaunchDaemons"
cp -R "$program/versions/$version" "$root/usr/local/hsn-hub/versions/$version"
install -m 0755 "$program/launcher/hsn-launcher" "$root/usr/local/libexec/hsn-hub/hsn-launcher"
install -m 0755 "$here/hsn" "$root/usr/local/bin/hsn"
install -m 0644 "$here/com.hsn.hub.plist" "$root/Library/LaunchDaemons/com.hsn.hub.plist"
scripts="$work/scripts"
mkdir -p "$scripts"
cp "$here/scripts/preinstall" "$here/scripts/postinstall" "$scripts/"
cp "$here/../shared/secure-data-folder.sh" "$here/../shared/open-setup-page.sh" "$scripts/"
printf '%s\n' "$version" > "$scripts/hsn-version"
mkdir -p "$out"
pkgbuild --root "$root" --scripts "$scripts" --identifier com.hsn.hub --version "$version" \
  --install-location / --ownership recommended "$out/HSN-Hub-$version.pkg" >/dev/null
echo "$out/HSN-Hub-$version.pkg"
