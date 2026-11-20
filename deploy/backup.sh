#!/usr/bin/env bash
# Daily Post Studio backup on the server (Phase 6). Run by post-studio-backup.service.
# Backs up the deployed data: VACUUM INTO snapshot + assets → <data>/backups/post-studio-<UTC>.tar.gz,
# keeping the newest 14. Runs inside the container (same code and native modules as the server);
# if the container is down, falls back to the host CLI on the same data dir.
set -euo pipefail
here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
keep="${POST_STUDIO_BACKUP_KEEP:-14}"
if [ "$(docker inspect -f '{{.State.Running}}' post-studio 2>/dev/null)" = "true" ]; then
  exec docker exec post-studio pstudio --json backup --keep "$keep"
fi
echo "post-studio container not running; backing up with the host CLI" >&2
export POST_STUDIO_DATA="${POST_STUDIO_DATA:-$HOME/.local/share/post-studio}"
exec "$here/apps/cli/bin/pstudio" --json backup --keep "$keep"
