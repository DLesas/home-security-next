#!/bin/sh
# secure-data-folder.sh <folder> <user> <group>
#
# The data folder is the hub's alone (hub-design.md sections 6 and 9; m2-design.md section 9): the
# folder 0700, owned by the hub's account, and nothing in it open to anyone else. Run by the
# macOS and Linux installers as root at install and at every upgrade, so a folder that was made
# open ends closed whatever the hub does at its own start. Creates the folder if it is missing.
set -eu
folder=$1
user=$2
group=$3
mkdir -p "$folder"
chown -R "$user:$group" "$folder"
chmod -R go-rwx "$folder"
chmod 0700 "$folder"
