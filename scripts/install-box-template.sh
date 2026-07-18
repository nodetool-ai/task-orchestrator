#!/usr/bin/env bash
# Build a clean Task Orchestrator Box template from two Git checkouts.
#
# Usage:
#   scripts/install-box-template.sh bx_...
#
# The Box CLI must already be authenticated and able to clone the configured
# GitHub repositories. This script deliberately does not accept, print, or
# persist a GitHub token; use the Box's existing Git credential setup.
#
# Optional overrides:
#   BOX_SHELL=zsh                         # shell that defines `box` (default: zsh)
#   TASK_ORCH_REPO_URL=https://github.com/nodetool-ai/task-orchestrator.git
#   TASK_ORCH_REPO_REF=main
#   NODETOOL_REPO_URL=https://github.com/nodetool-ai/nodetool.git
#   NODETOOL_REPO_REF=main

set -euo pipefail

box_id="${1:-}"
if [[ ! "$box_id" =~ ^bx_[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "Usage: $0 bx_<box-id>" >&2
  exit 2
fi

box_shell="${BOX_SHELL:-zsh}"
if ! command -v "$box_shell" >/dev/null 2>&1; then
  echo "BOX_SHELL '${box_shell}' was not found." >&2
  exit 2
fi

# `box` is commonly a shell function rather than an executable. A child bash
# process cannot inherit that definition, so every invocation goes through the
# user's interactive login shell (normally zsh), where .zshrc defines it.
if ! "$box_shell" -lic 'command -v box >/dev/null' >/dev/null 2>&1; then
  echo "The 'box' shell function is not available in ${box_shell} -lic." >&2
  echo "Set BOX_SHELL to the shell that defines it, or make the function available in its login config." >&2
  exit 2
fi

task_orch_url="${TASK_ORCH_REPO_URL:-https://github.com/nodetool-ai/task-orchestrator.git}"
task_orch_ref="${TASK_ORCH_REPO_REF:-main}"
nodetool_url="${NODETOOL_REPO_URL:-https://github.com/nodetool-ai/nodetool.git}"
nodetool_ref="${NODETOOL_REPO_REF:-main}"

quote() {
  printf '%q' "$1"
}

run_step() {
  local label="$1"
  local command="$2"
  echo
  echo "==> ${label}"
  "$box_shell" -lic 'box ssh "$@"' -- "$box_id" "$command"
}

task_orch_dir="/home/user/task-orchestrator"
nodetool_dir="/home/user/nodetool"

run_step "verify Box runtime" 'set -eu; command -v git; command -v node; command -v npm; node --version; npm --version'

# Refuse to write over a non-empty path. This is intended for a new Box; a
# retained template must be rebuilt explicitly rather than silently mixed with
# an unknown checkout.
run_step "clone Task Orchestrator" \
  "set -eu; test ! -e $(quote "$task_orch_dir"); git clone --depth 1 --branch $(quote "$task_orch_ref") $(quote "$task_orch_url") $(quote "$task_orch_dir")"

run_step "install Task Orchestrator dependencies" \
  "set -eu; cd $(quote "$task_orch_dir"); npm ci --omit=optional"

run_step "build Task Orchestrator worker (standalone bundle)" \
  "set -eu; cd $(quote "$task_orch_dir"); npm run build:worker:standalone; test -s dist/run-worker.standalone.js"

# Record the SHA before pruning deletes the checkout; the manifest step needs it.
run_step "record worker SHA" \
  "set -eu; git -C $(quote "$task_orch_dir") rev-parse HEAD > /home/user/.task-orchestrator-worker-sha"

run_step "prune worker checkout" \
  "set -eu; mkdir -p /home/user/worker; cp $(quote "$task_orch_dir")/dist/run-worker.standalone.js /home/user/worker/run-worker.js; rm -rf $(quote "$task_orch_dir")"

run_step "clone nodetool" \
  "set -eu; test ! -e $(quote "$nodetool_dir"); git clone --depth 1 --branch $(quote "$nodetool_ref") $(quote "$nodetool_url") $(quote "$nodetool_dir")"

run_step "write template manifest" \
  "set -eu; mkdir -p /home/user/.task-orchestrator; sha=\$(cat /home/user/.task-orchestrator-worker-sha); rm -f /home/user/.task-orchestrator-worker-sha; printf '{\"formatVersion\":1,\"workerBuildSha\":\"%s\",\"workerProtocolVersion\":1,\"repository\":\"nodetool-ai/nodetool\",\"repositoryPath\":\"/home/user/nodetool\",\"workerEntryPath\":\"/home/user/worker/run-worker.js\"}\\n' \"\$sha\" > /home/user/.task-orchestrator/template.json"

# Mirrors the "verifying-worker" step in lib/runner/box-template-builder.ts:
# run the bundle ALONE in a scratch dir (exit 2 = its own usage check, the
# full dependency graph loaded with no node_modules), exec the preinstalled
# claude binary, then sync so the archive can't seal half-written pages.
run_step "verify worker bundle and claude binary" \
  "set -eu; test -s /home/user/worker/run-worker.js; test -z \"\$(git -C $(quote "$nodetool_dir") status --porcelain=v1)\"; cat /home/user/.task-orchestrator/template.json; d=\$(mktemp -d); cp /home/user/worker/run-worker.js \"\$d/run-worker.js\"; cd \"\$d\"; node run-worker.js >/dev/null 2>&1 || rc=\$?; test \"\${rc:-0}\" -eq 2; /usr/local/bin/claude --version; sync"

echo
echo "Template install complete for ${box_id}."
echo "Review the final manifest, then archive the Box to publish its snapshot."
