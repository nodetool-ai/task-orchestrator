#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Install worktree GC as a *user-level* systemd timer (task-orchestrator-gc).
# Runs `npm run gc` (scripts/worktree-gc.ts) on a schedule, out-of-process from
# the web server (the in-server sweep is disabled in prod — see
# instrumentation.ts). No root needed; relies on lingering for the service user.
#
# Run as the service user:   ./scripts/install-gc-timer.sh
# =============================================================================

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/task-orchestrator-gc.service" <<EOF
[Unit]
Description=Task Orchestrator worktree GC (one-shot)

[Service]
Type=oneshot
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env.local
ExecStart=/bin/bash -lc '. $HOME/.nvm/nvm.sh && exec npm run gc'
EOF

cat > "$UNIT_DIR/task-orchestrator-gc.timer" <<'EOF'
[Unit]
Description=Hourly worktree GC for Task Orchestrator

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
EOF

if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "WARN: lingering is OFF for $USER — the timer won't fire without a session."
  echo "      Enable once (needs root): sudo loginctl enable-linger $USER"
fi

systemctl --user daemon-reload
systemctl --user enable --now task-orchestrator-gc.timer

echo "Installed task-orchestrator-gc.timer."
systemctl --user list-timers task-orchestrator-gc.timer --no-pager || true
