#!/bin/sh
# prepare-hub-folder.sh <folder> <user> <group>
#
# One of the hub's trees, its top folder only (m2-design.md section 9, "The privilege boundary"):
# run by the macOS and Linux installers as root at install and at every upgrade. It makes the
# folder if it is missing, refuses anything that is not a plain folder owned by the hub's account
# (or by root, just made), and sets the owner and mode 0700 on that folder alone: it never
# recurses, never reads inside and never follows a link. The hub tightens its own contents as
# itself at its start.
#
# A check and then a change are safe here because the folder's parent must be root's (or, run
# unprivileged in the tests, the caller's own) and writable by no one else: only its owner can
# replace the folder between the two. `mkdir` and `chown -h` never follow a link; `chmod` would,
# so it runs only after the second check that the folder is not one.
set -eu
folder=$1
user=$2
group=$3
refuse() {
  echo "hsn-hub: refusing $folder: $1" >&2
  exit 1
}
parent=$(dirname "$folder")
me=$(id -un)
[ -d "$parent" ] && [ ! -L "$parent" ] || refuse "its parent $parent is not a plain folder"
parent_owner=$(ls -ldn "$parent" | awk '{print $3}')
[ "$parent_owner" = 0 ] || [ "$parent_owner" = "$(id -u)" ] || refuse "its parent is not root's"
[ -z "$(find "$parent" -maxdepth 0 -perm -0002)" ] || refuse "its parent is writable by anyone"
[ -z "$(find "$parent" -maxdepth 0 -perm -0020)" ] || refuse "its parent is writable by its group"
if [ -L "$folder" ]; then refuse "it is a link"; fi
if [ -e "$folder" ] && [ ! -d "$folder" ]; then refuse "it is not a folder"; fi
[ -e "$folder" ] || mkdir -m 0700 "$folder"
if [ -L "$folder" ] || [ ! -d "$folder" ]; then refuse "it is not a plain folder"; fi
owner=$(ls -ld "$folder" | awk '{print $3}')
case "$owner" in
  "$user" | root | "$me") ;;
  *) refuse "it belongs to $owner" ;;
esac
chown -h "$user:$group" "$folder"
chmod 0700 "$folder"
