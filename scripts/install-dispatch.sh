#!/usr/bin/env bash
# Install (or reinstall) the hand-off dispatcher as a user service on the server (AGENTS.md "Hand-off dispatch").
# Creates the dispatcher token once (saved 0600, never printed), then enables the service.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
conf="${XDG_CONFIG_HOME:-$HOME/.config}/post-studio"
token_file="$conf/dispatcher-token"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$conf" "$unit_dir"
chmod 700 "$conf"
if [ ! -s "$token_file" ]; then
  # The admin command works on the data dir while the container runs (WAL); prints only the path.
  "$here/apps/cli/bin/pstudio" token create studio-dispatcher --save "$token_file" >/dev/null
  echo "created token studio-dispatcher → $token_file"
fi
chmod 600 "$token_file"
install -m 0644 "$here/deploy/post-studio-dispatch.service" "$unit_dir/"
systemctl --user daemon-reload
systemctl --user enable post-studio-dispatch.service
systemctl --user restart post-studio-dispatch.service
sleep 3
systemctl --user --no-pager --lines=5 status post-studio-dispatch.service || true
