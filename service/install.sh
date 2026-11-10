#!/usr/bin/env bash
# Run the web UI and the session host as long-lived macOS launchd jobs:
# started at boot or login, restarted if they exit, not tied to a terminal.
#
#   service/install.sh            install (or refresh) and start them
#   service/install.sh uninstall  stop them and remove their plists
#   service/install.sh status     launchd's view of them
#   service/install.sh print      write the web plist to stdout only
#   service/install.sh print-host write the session host plist to stdout only
#
# Two modes (D18), DEN_SERVICE_MODE:
#   login   (default) LaunchAgents in the desktop session (gui/<uid>): they
#           start at login and stop at logout, with every agent.
#   always  LaunchDaemons that run as you (UserName): they start at boot and
#           keep running across logout, so agents do too. One sudo writes
#           and loads them. No login keychain, no GUI there: agents use the
#           1Password service-account token, headless browsers, and Full
#           Disk Access for protected folders.
#
# The session host job runs DEN_SERVICE_HOST_EXE, a copy of node Den owns
# (<stateDir>/bin/<cli>-sessions-host): Full Disk Access is granted to that
# path, so it never goes to the shared node. A node change replaces the
# copy; the grant holds when the code signature's requirement is the same
# (an official node build), and install says to grant it again when not.
#
# Works from Den's checkout and from a distribution, where it lives in
# node_modules/@monster-orange/den/service/. The distribution root is
# DEN_ROOT, else this checkout when it holds den.yml.
#
#   DEN_SERVICE_LABEL       web job label (default local.<dist dir name>.web)
#   DEN_SERVICE_HOST_LABEL  host job label (default: the web label's .web → .sessions)
#   DEN_SERVICE_LOGS        log directory (default ~/Library/Logs/<dist dir name>)
#   DEN_SERVICE_NODE        the node the jobs run (default: see pick_node)
#   DEN_SERVICE_HOST_EXE    the host's node copy (default: none, the host runs that node)
#   DEN_SERVICE_READY_CHECK=external  install does not print "running": the
#                      caller (`<cli> service install`) checks the server
#                      answers first.
#   DEN_SERVICE_DAEMON_DIR, DEN_SERVICE_SUDO  (tests) where LaunchDaemons go
#                      and what runs as root (default /Library/LaunchDaemons, sudo)
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
HOST_LABEL="${DEN_SERVICE_HOST_LABEL:-${LABEL%.web}.sessions}"
LOGS="${DEN_SERVICE_LOGS:-$HOME/Library/Logs/$NAME}"
SVC_MODE="${DEN_SERVICE_MODE:-login}"
case "$SVC_MODE" in
  login|always) ;;
  *) echo "✗ DEN_SERVICE_MODE must be login or always, not \"$SVC_MODE\"" >&2; exit 2 ;;
esac
UID_N="$(id -u)"
USER_N="$(id -un)"
AGENT_DIR="$HOME/Library/LaunchAgents"
DAEMON_DIR="${DEN_SERVICE_DAEMON_DIR:-/Library/LaunchDaemons}"
SUDO="${DEN_SERVICE_SUDO-sudo}"
GUI="gui/$UID_N"

# The plist and domain for a label in a mode.
plist_for() { # $1 label $2 mode
  if [ "$2" = always ]; then echo "$DAEMON_DIR/$1.plist"; else echo "$AGENT_DIR/$1.plist"; fi
}
domain_for() { if [ "$1" = always ]; then echo system; else echo "$GUI"; fi; }
other_mode() { if [ "$1" = always ]; then echo login; else echo always; fi; }
# Root runs it in the system domain (a LaunchDaemon); else as you.
as_mode() { # $1 mode, then the command
  local m="$1"; shift
  if [ "$m" = always ] && [ -n "$SUDO" ]; then "$SUDO" "$@"; else "$@"; fi
}

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
    echo "⚠ the web job will run $node, a version manager's node: it stops starting" >&2
    echo "  when that version is removed (the session host runs Den's own copy of node)." >&2
    echo "  Re-run install after switching, or set DEN_SERVICE_NODE." >&2
  fi
  echo "$node"
}

# The code signature's designated requirement, or "" (unsigned, no codesign).
requirement() { codesign -d -r- "$1" 2>&1 | sed -n 's/^designated => //p' || true; }

# The host's node copy (D18): refreshed when node changed. Prints the path
# the host job runs: the copy, or node itself when it cannot be copied.
# A node linked to libraries beside it (Homebrew's) does not run copied.
self_contained() {
  ! { command -v otool >/dev/null 2>&1 && otool -L "$1" 2>/dev/null | grep -q '@rpath/\|/opt/homebrew/\|/usr/local/opt/'; }
}

host_exe() { # $1 node
  local node="$1" exe="${DEN_SERVICE_HOST_EXE:-}" c src=""
  if [ -z "$exe" ]; then echo "$node"; return; fi
  # The node the jobs run, else (unless DEN_SERVICE_NODE names one) the
  # PATH's: a version manager's is fine here, since the copy outlives it.
  for c in "$node" $([ -z "${DEN_SERVICE_NODE:-}" ] && command -v node 2>/dev/null); do
    if self_contained "$c"; then src="$c"; break; fi
  done
  if [ -z "$src" ]; then
    echo "⚠ $node is not self-contained (it loads libraries beside it), so the session host" >&2
    echo "  runs it directly: grant Full Disk Access to $node, and again after each node" >&2
    echo "  upgrade. An official node build (nodejs.org, nvm) avoids that: set DEN_SERVICE_NODE." >&2
    echo "$node"; return
  fi
  node="$src"
  if [ -f "$exe" ] && cmp -s "$node" "$exe"; then echo "$exe"; return; fi
  local before="" after
  [ -f "$exe" ] && before="$(requirement "$exe")"
  mkdir -p "$(dirname "$exe")"
  chmod 700 "$(dirname "$exe")"
  cp "$node" "$exe.new"
  chmod 700 "$exe.new"
  mv -f "$exe.new" "$exe"
  after="$(requirement "$exe")"
  case "$after" in
    "" | cdhash*)
      echo "⚠ $exe is a copy of $node, which has no stable code signature: Full Disk" >&2
      echo "  Access must be granted to it again after every node change. An official" >&2
      echo "  node build (nodejs.org, nvm) keeps the grant: set DEN_SERVICE_NODE." >&2 ;;
    *)
      if [ -n "$before" ] && [ "$before" != "$after" ]; then
        echo "⚠ $exe changed signer: grant it Full Disk Access again" >&2
        echo "  (System Settings → Privacy & Security → Full Disk Access)." >&2
      fi ;;
  esac
  echo "$exe"
}

write_plist() { # $1 = output file, $2 = web|host, $3 = mode
  # Warned once, for the web job: the host job runs Den's node copy.
  NODE="$(pick_node "$([ "$2" = web ] && echo "$MODE")")"
  TSX="$(find_tsx)" || { echo "✗ tsx not installed: run npm ci in $DIST" >&2; exit 1; }
  local exe="$NODE" label="$LABEL" log="web.log"
  if [ "$2" = host ]; then
    if [ "$MODE" = install ]; then exe="$(host_exe "$NODE")"; else exe="${DEN_SERVICE_HOST_EXE:-$NODE}"; fi
    label="$HOST_LABEL"; log="sessions-host.log"
  fi
  DOCKER_DIR="$(dirname "$(command -v docker || echo /usr/local/bin/docker)")"
  SVC_PATH="$(dirname "$NODE"):$DOCKER_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  python3 -I - "$1" "$2" "$3" "$label" "$exe" "$TSX" "$ENGINE" "$DIST" "$SVC_PATH" "$HOME" "$LOGS/$log" "$USER_N" <<'PY'
import plistlib, sys
out, kind, mode, label, exe, tsx, engine, dist, path, home, log, user = sys.argv[1:]
entry = (f"{engine}/src/ui/server/index.ts", "--silent") if kind == "web" \
    else (f"{engine}/src/ui/cli/index.ts", "sessions", "host", "--stand-by")
data = {
    "Label": label,
    "ProgramArguments": [exe, "--import", f"{tsx}/dist/loader.mjs", *entry],
    "WorkingDirectory": dist,
    "EnvironmentVariables": {"PATH": path, "HOME": home, "USER": user,
                             "LOGNAME": user,
                             "DEN_ROOT": dist, "DEN_ENGINE_ROOT": engine},
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    # Interactive, not Background: macOS gives Background agents efficiency
    # cores and throttled I/O, and the UI stalled for seconds under load.
    "ProcessType": "Interactive",
    "StandardOutPath": log,
    "StandardErrorPath": log,
}
if mode == "always":
    # A LaunchDaemon runs as root unless told otherwise: run as the person.
    data["UserName"] = user
if out == "-":
    sys.stdout.buffer.write(plistlib.dumps(data))
else:
    with open(out, "wb") as f:
        plistlib.dump(data, f)
PY
}

# Stop and remove a job (any mode), quietly when it is not there.
remove_job() { # $1 label $2 mode
  local plist; plist="$(plist_for "$1" "$2")"
  if [ "$2" = always ]; then
    [ -f "$plist" ] || return 0
  fi
  as_mode "$2" launchctl bootout "$(domain_for "$2")/$1" 2>/dev/null || true
  [ -f "$plist" ] && as_mode "$2" rm -f "$plist"
  return 0
}

# Install and start one job in SVC_MODE.
load_job() { # $1 label $2 web|host
  local label="$1" plist domain tmp
  plist="$(plist_for "$label" "$SVC_MODE")"
  domain="$(domain_for "$SVC_MODE")"
  tmp="$(mktemp "${TMPDIR:-/tmp}/den-plist.XXXXXX")"
  write_plist "$tmp" "$2" "$SVC_MODE"
  plutil -lint "$tmp" >/dev/null
  # The other mode's job is the same service: never both.
  remove_job "$label" "$(other_mode "$SVC_MODE")"
  as_mode "$SVC_MODE" launchctl bootout "$domain/$label" 2>/dev/null || true
  # bootout returns before launchd has let go of the label; a bootstrap
  # straight after fails ("Bootstrap failed: 5") and leaves NO service.
  # Wait for it to go, then retry bootstrap a few times.
  for _ in $(seq 1 50); do
    as_mode "$SVC_MODE" launchctl print "$domain/$label" >/dev/null 2>&1 || break
    sleep 0.2
  done
  if [ "$SVC_MODE" = always ]; then
    as_mode always install -o root -g wheel -m 644 "$tmp" "$plist"
    rm -f "$tmp"
  else
    mkdir -p "$(dirname "$plist")"
    mv "$tmp" "$plist"
  fi
  local loaded=0
  for _ in 1 2 3 4 5; do
    if as_mode "$SVC_MODE" launchctl bootstrap "$domain" "$plist" 2>/dev/null; then loaded=1; break; fi
    sleep 1
  done
  [ "$loaded" = 1 ] || { echo "✗ launchctl bootstrap failed for $label (plist: $plist)" >&2; exit 1; }
  as_mode "$SVC_MODE" launchctl kickstart -k "$domain/$label"
}

# The job's state, as status shows it.
job_status() { # $1 label
  local m plist domain svc_node out
  for m in always login; do
    plist="$(plist_for "$1" "$m")"
    [ -f "$plist" ] || continue
    domain="$(domain_for "$m")"
    # The node it was installed with may be gone (a removed nvm version):
    # launchd then restarts it forever with no useful message.
    if command -v plutil >/dev/null 2>&1; then
      svc_node="$(plutil -extract ProgramArguments.0 raw -o - "$plist" 2>/dev/null || true)"
      if [ -n "$svc_node" ] && [ ! -x "$svc_node" ]; then
        echo "✗ $1 runs $svc_node, which no longer exists: re-run service install" >&2
        return 1
      fi
    fi
    echo "$1 ($m: $domain)"
    if out="$(launchctl print "$domain/$1" 2>/dev/null)"; then
      printf '%s\n' "$out" | grep -E '^\s*(state|pid|last exit code|runs|spawn type)'
    else
      echo "  plist present, job not loaded: $([ "$m" = always ] && echo "sudo ")launchctl bootstrap $domain $plist"
    fi
    return 0
  done
  # launchctl's own "Could not find service" is noise when it isn't loaded.
  echo "$1 is not loaded"
}

MODE="${1:-install}"
case "$MODE" in
  install)
    mkdir -p "$LOGS"
    if [ "$SVC_MODE" = always ] && [ -n "$SUDO" ]; then
      echo "… $SVC_MODE: LaunchDaemons running as $USER_N need your admin password once (sudo)"
    fi
    load_job "$HOST_LABEL" host
    load_job "$LABEL" web
    if [ "${DEN_SERVICE_READY_CHECK:-}" = external ]; then
      echo "… $LABEL started ($SVC_MODE); waiting for it to answer"
    else
      echo "✓ $LABEL running ($SVC_MODE; logs: $LOGS/web.log)"
    fi
    ;;
  uninstall)
    for m in login always; do
      remove_job "$LABEL" "$m"
      remove_job "$HOST_LABEL" "$m"
    done
    echo "✓ $LABEL and $HOST_LABEL removed"
    ;;
  print)
    write_plist - web "$SVC_MODE"
    ;;
  print-host)
    write_plist - host "$SVC_MODE"
    ;;
  status)
    job_status "$LABEL"
    job_status "$HOST_LABEL"
    ;;
  *) echo "usage: $0 [install|uninstall|status|print|print-host]" >&2; exit 2 ;;
esac
