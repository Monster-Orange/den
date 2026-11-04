#!/usr/bin/env bash
# Run the web UI as a long-lived macOS service (a launchd LaunchAgent):
# started at login, restarted if it exits, not tied to any terminal.
#
#   service/install.sh            install (or refresh) and start it
#   service/install.sh uninstall  stop it and remove the LaunchAgent
#   service/install.sh status     launchd's view of it
#   service/install.sh print      write the LaunchAgent plist to stdout only
#
# Works from Den's checkout and from a distribution, where it lives in
# node_modules/@monster-orange/den/service/. The distribution root is
# DEN_ROOT, else this checkout when it holds den.yml. The agent runs the
# engine's server with the node found on PATH now, from the distribution
# root; re-run install after changing node versions.
#
#   DEN_SERVICE_LABEL  launchd label (default local.<dist dir name>.web)
#   DEN_SERVICE_LOGS   log directory (default ~/Library/Logs/<dist dir name>)
#   DEN_SERVICE_READY_CHECK=external  install does not print "running": the
#                      caller (`<cli> service install`) checks the server
#                      answers first.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENGINE="$(cd "$HERE/.." && pwd)"
if [ -n "${DEN_ROOT:-}" ]; then
  DIST="$(cd "$DEN_ROOT" && pwd)"
elif [ -f "$ENGINE/den.yml" ]; then
  DIST="$ENGINE"
else
  echo "✗ set DEN_ROOT to your distribution's root (the directory with den.yml)" >&2
  exit 1
fi
[ -f "$DIST/den.yml" ] || { echo "✗ $DIST has no den.yml" >&2; exit 1; }
NAME="$(basename "$DIST")"
LABEL="${DEN_SERVICE_LABEL:-local.$NAME.web}"
LOGS="${DEN_SERVICE_LOGS:-$HOME/Library/Logs/$NAME}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# tsx: the nearest node_modules/tsx at or above the engine (hoisted installs).
find_tsx() {
  local d="$ENGINE"
  while :; do
    if [ -f "$d/node_modules/tsx/package.json" ]; then echo "$d/node_modules/tsx"; return 0; fi
    [ "$d" = "/" ] && return 1
    d="$(dirname "$d")"
  done
}

write_plist() { # $1 = output file
  NODE="$(command -v node)" || { echo "✗ node is not on PATH" >&2; exit 1; }
  TSX="$(find_tsx)" || { echo "✗ tsx not installed: run npm ci in $DIST" >&2; exit 1; }
  DOCKER_DIR="$(dirname "$(command -v docker || echo /usr/local/bin/docker)")"
  SVC_PATH="$(dirname "$NODE"):$DOCKER_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  python3 -I - "$1" "$LABEL" "$NODE" "$TSX" "$ENGINE" "$DIST" "$SVC_PATH" "$HOME" "$LOGS" <<'PY'
import plistlib, sys
out, label, node, tsx, engine, dist, path, home, logs = sys.argv[1:]
data = {
    "Label": label,
    "ProgramArguments": [node, "--import", f"{tsx}/dist/loader.mjs",
                         f"{engine}/src/ui/server/index.ts", "--silent"],
    "WorkingDirectory": dist,
    "EnvironmentVariables": {"PATH": path, "HOME": home,
                             "DEN_ROOT": dist, "DEN_ENGINE_ROOT": engine},
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ProcessType": "Background",
    "StandardOutPath": f"{logs}/web.log",
    "StandardErrorPath": f"{logs}/web.log",
}
if out == "-":
    sys.stdout.buffer.write(plistlib.dumps(data))
else:
    with open(out, "wb") as f:
        plistlib.dump(data, f)
PY
}

case "${1:-install}" in
  install)
    mkdir -p "$LOGS" "$(dirname "$PLIST")"
    write_plist "$PLIST.new"
    plutil -lint "$PLIST.new" >/dev/null
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # bootout returns before launchd has let go of the label; a bootstrap
    # straight after fails ("Bootstrap failed: 5") and leaves NO service.
    # Wait for it to go, then retry bootstrap a few times.
    for _ in $(seq 1 50); do
      launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
      sleep 0.2
    done
    mv "$PLIST.new" "$PLIST"
    loaded=0
    for _ in 1 2 3 4 5; do
      if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then loaded=1; break; fi
      sleep 1
    done
    [ "$loaded" = 1 ] || { echo "✗ launchctl bootstrap failed for $LABEL (plist: $PLIST)" >&2; exit 1; }
    launchctl kickstart -k "$DOMAIN/$LABEL"
    if [ "${DEN_SERVICE_READY_CHECK:-}" = external ]; then
      echo "… $LABEL started; waiting for it to answer"
    else
      echo "✓ $LABEL running (logs: $LOGS/web.log)"
    fi
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✓ $LABEL removed"
    ;;
  print)
    write_plist -
    ;;
  status)
    # launchctl's own "Could not find service" is noise when it isn't loaded.
    if out="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"; then
      printf '%s\n' "$out" | grep -E '^\s*(state|pid|last exit code|runs)'
    else
      echo "$LABEL is not loaded"
    fi
    ;;
  *) echo "usage: $0 [install|uninstall|status|print]" >&2; exit 2 ;;
esac
