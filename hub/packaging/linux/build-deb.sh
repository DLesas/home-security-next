#!/bin/sh
# build-deb.sh <amd64|arm64> <out folder>
#
# Builds hsn-hub_<version>_<arch>.deb (m2-design.md section 9) on a Debian or Ubuntu machine of
# that architecture (an Ubuntu runner, or a Raspberry Pi OS 64-bit for arm64), from a checkout with
# the web app exported (`bun run app:export`). Needs Bun and dpkg-deb; downloads nothing.
set -eu
arch=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
case "$arch" in
  amd64) target=bun-linux-x64 ;;
  arm64) target=bun-linux-arm64 ;;
  *) echo "build-deb: amd64 or arm64" >&2; exit 2 ;;
esac
command -v dpkg-deb >/dev/null || { echo "build-deb: needs dpkg-deb" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
bun "$repo/hub/packaging/shared/build-program.ts" --target "$target" --out "$work/program" >/dev/null
version=$(cat "$work/program/version")
root="$work/root"
mkdir -p "$root/DEBIAN" "$root/opt/hsn-hub/versions" "$root/usr/lib/hsn-hub" "$root/lib/systemd/system" "$root/usr/bin"
cp -R "$work/program/versions/$version" "$root/opt/hsn-hub/versions/$version"
install -m 0755 "$work/program/launcher/hsn-launcher" "$root/usr/lib/hsn-hub/hsn-launcher"
install -m 0755 "$here/../shared/secure-data-folder.sh" "$root/usr/lib/hsn-hub/secure-data-folder.sh"
install -m 0755 "$here/../shared/open-setup-page.sh" "$root/usr/lib/hsn-hub/open-setup-page.sh"
printf '%s\n' "$version" > "$root/usr/lib/hsn-hub/version"
install -m 0644 "$here/hsn-hub.service" "$root/lib/systemd/system/hsn-hub.service"
install -m 0755 "$here/hsn" "$root/usr/bin/hsn"
sed -e "s/@VERSION@/$version/" -e "s/@ARCH@/$arch/" "$here/debian/control.in" > "$root/DEBIAN/control"
for script in postinst prerm postrm; do install -m 0755 "$here/debian/$script" "$root/DEBIAN/$script"; done
mkdir -p "$out"
dpkg-deb --root-owner-group --build "$root" "$out/hsn-hub_${version}_${arch}.deb"
echo "$out/hsn-hub_${version}_${arch}.deb"
