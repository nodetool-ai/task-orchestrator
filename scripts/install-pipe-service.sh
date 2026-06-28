#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Install the Discord pipe bridge as a *user-level* systemd service
# (task-orchestrator-pipe). Runs `npm run pipe`. No root required — relies on
# lingering being enabled for the service user so it survives logout/reboot:
#   loginctl enable-linger "$USER"   # one-time, needs root if not already on
#
# The webhook deploy (deploy.sh -> restart_pipe) restarts it via
# `systemctl --user`, so no sudoers rule is needed.
#
# Run as the service user:   ./scripts/install-pipe-service.sh
# =============================================================================

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/task-orchestrator-pipe.service"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=Task Orchestrator Discord Pipe (npm run pipe)
After=default.target

[Service]
Type=simple
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env.local
ExecStart=/bin/bash -lc '. $HOME/.nvm/nvm.sh && exec npm run pipe'
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
EOF

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "WARN: lingering is OFF for $USER — the pipe will stop on logout."
  echo "      Enable it once (needs root): sudo loginctl enable-linger $USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now task-orchestrator-pipe

echo "Installed and started task-orchestrator-pipe (user)."
systemctl --user --no-pager --lines=0 status task-orchestrator-pipe || true
