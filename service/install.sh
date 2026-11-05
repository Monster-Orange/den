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
#   DEN_SERVICE_NODE   the node the agent runs (default: see pick_node)
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

# A version manager's node (nvm, fnm, volta, asdf, mise) lives under a
# versioned path that disappears when that version is removed, and the agent
# then fails to start with no clear reason. Prefer a stable install of the
# same major version; otherwise keep it and say so.
STABLE_NODES="${DEN_SERVICE_STABLE_NODES:-/opt/homebrew/bin/node /usr/local/bin/node}"
node_major() { "$1" -p "process.versions.node.split('.')[0]" 2>/dev/null; }
pick_node() {
  if [ -n "${DEN_SERVICE_NODE:-}" ]; then
    [ -x "$DEN_SERVICE_NODE" ] || { echo "✗ DEN_SERVICE_NODE ($DEN_SERVICE_NODE) is not executable" >&2; exit 1; }
    echo "$DEN_SERVICE_NODE"; return
  fi
  local node; node="$(command -v node)" || { echo "✗ node is not on PATH" >&2; exit 1; }
  case "$node" in
    */.nvm/*|*/fnm/*|*/.fnm/*|*/.volta/*|*/.asdf/*|*/mise/*) ;;
    *) echo "$node"; return ;;
  esac
  local want c; want="$(node_major "$node")"
  for c in $STABLE_NODES; do
    if [ -x "$c" ] && [ "$(node_major "$c")" = "$want" ]; then echo "$c"; return; fi
  done
  # Warn when installing; `print` writes the plist and nothing else.
  if [ "${1:-}" = install ]; then
    echo "⚠ the service will run $node, a version manager's node: it stops starting" >&2
    echo "  when that version is removed. Re-run install after switching, or set DEN_SERVICE_NODE." >&2
  fi
  echo "$node"
}

write_plist() { # $1 = output file
  NODE="$(pick_node "$MODE")"
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
    # Interactive, not Background: macOS gives Background agents efficiency
    # cores and throttled I/O, and the UI stalled for seconds under load.
    "ProcessType": "Interactive",
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

MODE="${1:-install}"
case "$MODE" in
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
    # The node the agent was installed with may be gone (a removed nvm
    # version): launchd then restarts it forever with no useful message.
    if [ -f "$PLIST" ] && command -v plutil >/dev/null 2>&1; then
      svc_node="$(plutil -extract ProgramArguments.0 raw -o - "$PLIST" 2>/dev/null || true)"
      if [ -n "$svc_node" ] && [ ! -x "$svc_node" ]; then
        echo "✗ $LABEL runs $svc_node, which no longer exists: re-run service install" >&2
        exit 1
      fi
    fi
    # launchctl's own "Could not find service" is noise when it isn't loaded.
    if out="$(launchctl print "$DOMAIN/$LABEL" 2>/dev/null)"; then
      printf '%s\n' "$out" | grep -E '^\s*(state|pid|last exit code|runs|spawn type)'
    else
      echo "$LABEL is not loaded"
    fi
    ;;
  *) echo "usage: $0 [install|uninstall|status|print]" >&2; exit 2 ;;
esac
