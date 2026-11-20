#!/usr/bin/env bash
# Install the daily backup timer as a user unit on the server (backs up the deployed container data; Phase 6).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
install -m 0644 "$here/deploy/post-studio-backup.service" "$here/deploy/post-studio-backup.timer" "$unit_dir/"
systemctl --user daemon-reload
systemctl --user enable --now post-studio-backup.timer
systemctl --user list-timers post-studio-backup.timer --no-pager
