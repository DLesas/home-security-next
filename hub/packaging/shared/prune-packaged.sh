#!/bin/sh
# prune-packaged.sh <packaged folder> <this package's version>
#
# The package's tree keeps the packaged version and the one before it (m2-design.md section 9,
# "Which version runs"): every other version folder in `packaged/` removed. Run as root in the
# package's own root-owned tree only; never in a hub tree.
set -eu
packaged=$1
version=$2
[ -d "$packaged" ] && [ ! -L "$packaged" ] || exit 0
# The newest other version, by its numbers.
keep=$(ls -1 "$packaged" | grep -v -x -F "$version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+' | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1 || true)
for name in $(ls -1 "$packaged"); do
  [ "$name" = "$version" ] && continue
  [ -n "$keep" ] && [ "$name" = "$keep" ] && continue
  rm -rf "${packaged:?}/$name"
done
