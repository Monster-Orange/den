#!/usr/bin/env bash
# Run Den's web UI as a long-lived macOS service (a launchd LaunchAgent):
# started at login, restarted if it exits, not tied to any terminal.
#
#   service/install.sh            install (or refresh) and start it
#   service/install.sh uninstall  stop it and remove the LaunchAgent
#   service/install.sh status     launchd's view of it
#
# The agent runs `node --import tsx src/ui/server/index.ts` from this checkout
# with the node found on PATH now; re-run install after changing node versions.
# The UI listens on web.port (config/den.yml) and the edge routes
# https://den.<edge.domain> to it.
set -euo pipefail

# launchd label; a distribution sets its own.
LABEL="${DEN_SERVICE_LABEL:-local.den.web}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/Den"
DOMAIN="gui/$(id -u)"

case "${1:-install}" in
  install)
    NODE="$(command -v node)" || { echo "✗ node is not on PATH" >&2; exit 1; }
    [ -x "$REPO/node_modules/.bin/tsx" ] || { echo "✗ run npm ci in $REPO first" >&2; exit 1; }
    DOCKER_DIR="$(dirname "$(command -v docker || echo /usr/local/bin/docker)")"
    SVC_PATH="$(dirname "$NODE"):$DOCKER_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    mkdir -p "$LOGS" "$(dirname "$PLIST")"
    python3 -I - "$PLIST.new" "$LABEL" "$NODE" "$REPO" "$SVC_PATH" "$HOME" "$LOGS" <<'PY'
import plistlib, sys
out, label, node, repo, path, home, logs = sys.argv[1:]
with open(out, "wb") as f:
    plistlib.dump({
        "Label": label,
        "ProgramArguments": [node, "--import", "tsx", "src/ui/server/index.ts", "--silent"],
        "WorkingDirectory": repo,
        "EnvironmentVariables": {"PATH": path, "HOME": home},
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "ProcessType": "Background",
        "StandardOutPath": f"{logs}/web.log",
        "StandardErrorPath": f"{logs}/web.log",
    }, f)
PY
    plutil -lint "$PLIST.new" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    mv "$PLIST.new" "$PLIST"
    launchctl bootstrap "$DOMAIN" "$PLIST"
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "✓ $LABEL running (logs: $LOGS/web.log)"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ $LABEL removed"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code|runs)' || echo "$LABEL is not loaded"
    ;;
  *) echo "usage: $0 [install|uninstall|status]" >&2; exit 2 ;;
esac
