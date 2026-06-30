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
# Source nvm, then select a node version explicitly. \`nvm use default\` covers
# the normal case; the \`|| nvm use node\` fallback picks the latest installed
# version so a missing/cleared \`default\` alias can't leave npm off PATH and
# crash-loop the bridge (status=127 "npm: not found"). A plain \`bash -lc\` login
# shell is NOT enough: under systemd the non-interactive login shell may not put
# an nvm-managed npm on PATH, which is exactly what caused the crash loop.
ExecStart=/bin/bash -c '. \$HOME/.nvm/nvm.sh && { nvm use --silent default 2>/dev/null || nvm use --silent node; } && exec npm run pipe'
Restart=on-failure
RestartSec=5s
# Bound the cgroup so a heavy agent turn (worktree dev servers, model/render
# subprocesses spawned as children) can't exhaust a small, swapless host and
# trip the system-wide OOM killer. MemoryMax makes the kernel OOM-kill *within*
# this cgroup instead; OOMPolicy=continue keeps the bridge up when a child is
# killed (one session dies, not all). Runs orphaned by a kill self-heal on the
# next boot via runs.reconcileOrphanedRuns(). Tune for the host's RAM.
MemoryHigh=4G
MemoryMax=5G
OOMPolicy=continue

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
