#!/usr/bin/env bash
# dist-smoke: prove Den runs as an installed package inside a distribution.
#
#   npm pack → npx --package <tarball> den create acme → npm install <tarball> → run it
#
# Checks: the scaffold equals examples/distribution; the CLI runs under its
# own name (acme) with no stderr noise; ACME_HOME moves the state dir; make
# targets resolve Den's files from node_modules; the web server serves the
# acme brand (page + /api) with no __DEN_ placeholder left.
#
# Usage: scripts/dist-smoke.sh            (from Den's checkout; CI runs it too)
#        DIST_SMOKE_OMIT_OPTIONAL=1 scripts/dist-smoke.sh
#                                         (installs with --omit=optional: no
#                                         PTY module, den-pty unavailable)
# The throwaway install lives under $RUNNER_TEMP (CI) or $TMPDIR.
set -euo pipefail

DEN="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
WORK="$(cd "$(mktemp -d "${BASE%/}/den-dist-smoke.XXXXXX")" && pwd -P)"
DIST="$WORK/acme"
export ACME_HOME="$WORK/acme-home"
# create looks for a free web port from here instead of the default (7777),
# so the smoke never probes another Den on this machine.
DEN_WEB_PORT_START="$(node -e 'const s=require("net").createServer();s.listen(0,"localhost",()=>{console.log(s.address().port);s.close()})')"
export DEN_WEB_PORT_START
PORT=""
fails=0

say() { printf '\n== %s\n' "$*"; }
ok() { printf '  ok   %s\n' "$*"; }
bad() {
  printf '  FAIL %s\n' "$*"
  fails=$((fails + 1))
}

stop_web() {
  if [ -n "$PORT" ] && [ -x "$DIST/bin/acme" ]; then
    (cd "$DIST" && ./bin/acme web down --port "$PORT" >/dev/null 2>&1) || true
  fi
  # Fallback: a server this run started (cwd under $WORK) still on the port.
  if [ -n "$PORT" ]; then
    for pid in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); do
      case "$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')" in
        "$WORK"/*) kill "$pid" 2>/dev/null || true ;;
      esac
    done
  fi
}
# A session host this run started (ACME_HOME is ours) never outlives it.
stop_sessions() {
  if [ -x "$DIST/bin/acme" ] && [ -S "$ACME_HOME/sessions.sock" ]; then
    (cd "$DIST" && ./bin/acme sessions host --stop >/dev/null 2>&1) || true
  fi
}
cleanup() {
  stop_web
  stop_sessions
}
trap cleanup EXIT

# run <label> <cmd...>: run in the distribution; stdout → $WORK/<label>.out,
# stderr → $WORK/<label>.err. Fails on a non-zero exit or any stderr output.
run() {
  local label="$1"
  shift
  if (cd "$DIST" && "$@") >"$WORK/$label.out" 2>"$WORK/$label.err"; then
    if [ -s "$WORK/$label.err" ]; then
      bad "$label: wrote to stderr:"
      sed 's/^/       /' "$WORK/$label.err" | head -20
    else
      ok "$label"
    fi
  else
    bad "$label: exit $?"
    sed 's/^/       /' "$WORK/$label.err" "$WORK/$label.out" | head -30
  fi
}

expect_in() { # expect_in <label> <file> <fixed string>
  if grep -qF -- "$3" "$2"; then ok "$1"; else bad "$1: '$3' not in $(basename "$2")"; fi
}
expect_re() { # expect_re <label> <file> <extended regex>
  if grep -qE -- "$3" "$2"; then ok "$1"; else bad "$1: /$3/ not in $(basename "$2")"; fi
}
expect_not_in() {
  if grep -qF -- "$3" "$2"; then
    bad "$1: '$3' found in $(basename "$2")"
    grep -nF -- "$3" "$2" | head -5 | sed 's/^/       /'
  else ok "$1"; fi
}

say "pack Den"
(cd "$DEN" && npm pack --silent --pack-destination "$WORK" >"$WORK/pack.out")
TARBALL="$WORK/$(tail -1 "$WORK/pack.out")"
[ -f "$TARBALL" ] || {
  echo "npm pack produced no tarball" >&2
  exit 1
}
ok "$(basename "$TARBALL") ($(du -k "$TARBALL" | cut -f1) KB)"
# The README's screenshots (docs/images/, DOC-1) live in the repo, never in
# the package: package.json `files` has !docs/images/. Images anywhere else
# in the tarball are a size regression too.
tar -tzf "$TARBALL" >"$WORK/tarball.list"
if grep -qE '^package/docs/images/|\.(png|gif|webp|jpe?g)$' "$WORK/tarball.list"; then
  bad "images in the tarball (package.json files needs !docs/images/):"
  grep -E '^package/docs/images/|\.(png|gif|webp|jpe?g)$' "$WORK/tarball.list" | head -5 | sed 's/^/       /'
else
  ok "no images in the tarball"
fi

# The install-den agent skill (ON-1) ships in the package, next to the
# CLI whose flags it names.
if grep -qxF 'package/skills/install-den/SKILL.md' "$WORK/tarball.list"; then
  ok "skills/install-den/SKILL.md in the tarball"
else
  bad "skills/install-den/SKILL.md not in the tarball (package.json files needs skills/)"
fi

say "scaffold: npx --package <tarball> den create acme"
if (cd "$WORK" && npx --yes --package "$TARBALL" den create acme "$DIST") >"$WORK/create.out" 2>"$WORK/create.err"; then
  ok "create"
else
  bad "create failed"
  sed 's/^/       /' "$WORK/create.err" "$WORK/create.out" | head -30
  echo "dist-smoke: $fails failure(s); work dir $WORK"
  exit 1
fi
[ -x "$DIST/bin/acme" ] && ok "bin/acme is executable" || bad "bin/acme is not executable"
if diff -r "$DEN/examples/distribution" "$DIST" >"$WORK/example.diff"; then
  ok "scaffold equals examples/distribution"
else
  bad "scaffold differs from examples/distribution:"
  head -30 "$WORK/example.diff" | sed 's/^/       /'
fi

say "install the tarball into the distribution"
OMIT=()
[ "${DIST_SMOKE_OMIT_OPTIONAL:-}" = "1" ] && OMIT=(--omit=optional)
(cd "$DIST" && npm install --no-audit --no-fund --silent ${OMIT[@]+"${OMIT[@]}"} "$TARBALL") >"$WORK/install.out" 2>&1 ||
  {
    cat "$WORK/install.out"
    exit 1
  }
ENGINE="$DIST/node_modules/@monster-orange/den"
[ -f "$ENGINE/bin/den" ] && ok "engine installed" || bad "no engine in node_modules"
[ ! -e "$ENGINE/den.yml" ] && ok "engine ships no den.yml" || bad "engine ships den.yml"

say "CLI"
run help ./bin/acme --help
expect_in "help names the acme CLI" "$WORK/help.out" "acme "
expect_not_in "help has no placeholder" "$WORK/help.out" "__DEN_"
run status ./bin/acme status
run graph ./bin/acme graph
run version ./bin/acme --version
DEN_VERSION="$(node -p "require('$ENGINE/package.json').version")"
expect_in "version is Den's ($DEN_VERSION)" "$WORK/version.out" "v$DEN_VERSION"

say "sessions (den-pty)"
# The PTY module is optional: with it doctor says den-pty is available;
# without it (--omit=optional) doctor says why, and nothing else changes.
run doctor ./bin/acme doctor
# D9: a fresh install's doctor shows no false failure row.
expect_not_in "doctor: no (invalid config) row" "$WORK/doctor.out" "invalid config"
if [ -d "$DIST/node_modules/@lydell/node-pty" ]; then
  ok "PTY module installed (no install script, prebuilt binary)"
  expect_re "doctor: den-pty available" "$WORK/doctor.out" "den-pty \(implicit\) +✓ available"
else
  ok "PTY module absent"
  expect_in "doctor says why den-pty is unavailable" "$WORK/doctor.out" "@lydell/node-pty is not installed"
fi
# list starts the session host on demand; --stop ends it.
run sessions-list ./bin/acme sessions list
expect_in "sessions list (host started on demand)" "$WORK/sessions-list.out" "no sessions"
if [ -S "$ACME_HOME/sessions.sock" ]; then ok "the host's socket is in ACME_HOME"; else bad "no sessions.sock in ACME_HOME"; fi
run sessions-host-stop ./bin/acme sessions host --stop
expect_in "sessions host --stop" "$WORK/sessions-host-stop.out" "stopped the session host"
[ ! -e "$ACME_HOME/sessions.sock" ] && ok "host stopped: socket removed" || bad "sessions.sock left behind"
# Den's default persona pack ships in the package and is read from there.
run agents-personas ./bin/acme agents personas
expect_in "agents personas: the default pack ships" "$WORK/agents-personas.out" "orchestrator"
expect_in "agents personas: planner is listed" "$WORK/agents-personas.out" "planner"
expect_in "doctor: the runtime kind is listed" "$WORK/doctor.out" "den-claude (implicit)"
# Den's guardrails (den#5) ship in the package: the default pack's hooks,
# their settings fragment and the shared persona instructions.
for f in pretooluse.mjs stop-hook.ts hooks.json instructions.md; do
  [ -f "$ENGINE/src/shared/agents/guardrails/$f" ] && ok "guardrails ship: $f" || bad "guardrails missing from the package: $f"
done
# The PreToolUse hook runs from the install and blocks a polling loop.
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"until true; do sleep 2; done"}}' |
  node "$ENGINE/src/shared/agents/guardrails/pretooluse.mjs" >/dev/null 2>"$WORK/pretool.err" && pre=0 || pre=$?
[ "$pre" = 2 ] && ok "the PreToolUse hook blocks sleep from the install" || bad "the PreToolUse hook exited $pre, not 2"
# The hand-back check runs as the distribution's CLI.
printf '## Hand-back\n- URL: https://x.example\n' >"$WORK/handback.md"
(cd "$DIST" && ./bin/acme agents handback-check "$WORK/handback.md") >"$WORK/handback.out" 2>&1 && hb=0 || hb=$?
[ "$hb" = 1 ] && ok "agents handback-check rejects an incomplete hand-back" || bad "agents handback-check exited $hb, not 1"
expect_in "agents handback-check names the missing part" "$WORK/handback.out" 'Missing "Machine:"'

say "MCP server (stdio)"
# initialize + tools/list need no web server; every stdout line must be
# protocol. stderr carries the server's one startup line, so it isn't checked.
if (cd "$DIST" && node "$DEN/scripts/mcp-smoke.mjs" ./bin/acme) >"$WORK/mcp.out" 2>"$WORK/mcp.err"; then
  ok "acme mcp answers initialize and tools/list"
  expect_in "mcp serves the acme profile" "$WORK/mcp.out" "server acme:"
  expect_in "mcp lists the read tools" "$WORK/mcp.out" "edge_status"
else
  bad "acme mcp failed:"
  sed 's/^/       /' "$WORK/mcp.err" "$WORK/mcp.out" | head -20
fi

say "make (dry run) from the distribution root"
run make-help make help
run make-status make -n acme-status
expect_in "service targets take the distribution's name" "$WORK/make-status.out" \
  "node_modules/@monster-orange/den/bin/den status"
run make-smoke make -n test-smk-all repo=shop
expect_in "smoke target runs Den's playwright config" "$WORK/make-smoke.out" \
  "node_modules/@monster-orange/den/src/pillars/smoke/playwright-all.config.ts"
run make-browser make -n test-syn-all repo=shop
expect_in "browser target runs Den's setup" "$WORK/make-browser.out" \
  "node_modules/@monster-orange/den/src/pillars/browser/setup.ts"

say "launchd service (print only; nothing installed)"
run service-print env DEN_ROOT="$DIST" DEN_SERVICE_LABEL=local.acme.web \
  bash node_modules/@monster-orange/den/service/install.sh print
expect_in "service runs the engine's server" "$WORK/service-print.out" \
  "node_modules/@monster-orange/den/src/ui/server/index.ts"
expect_in "service runs from the distribution root" "$WORK/service-print.out" \
  "<string>$DIST</string>"
expect_in "service keeps the given label" "$WORK/service-print.out" \
  "<string>local.acme.web</string>"
loader="$(sed -n 's#.*<string>\(.*/tsx/dist/loader.mjs\)</string>.*#\1#p' "$WORK/service-print.out" | head -1)"
if [ -n "$loader" ] && [ -f "$loader" ]; then ok "service's tsx loader exists"; else bad "service's tsx loader missing: '$loader'"; fi
# The CLI over the same script: with no web.service in the config, the label
# and logs are the script's own defaults, so existing installs keep theirs.
run service-cli-print ./bin/acme service print
expect_in "acme service print runs the engine's server" "$WORK/service-cli-print.out" \
  "node_modules/@monster-orange/den/src/ui/server/index.ts"
expect_in "acme service print keeps the script's default label" "$WORK/service-cli-print.out" \
  "<string>local.acme.web</string>"
expect_in "acme service print keeps the script's default logs" "$WORK/service-cli-print.out" \
  "Library/Logs/acme/web.log</string>"

say "web server"
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"localhost",()=>{console.log(s.address().port);s.close()})')"
run web-up ./bin/acme web up --no-open --port "$PORT"
if curl -fsS "http://localhost:$PORT/" -o "$WORK/page.html"; then
  ok "GET /"
  expect_in "page title shows the acme brand" "$WORK/page.html" "<title>Acme"
  expect_not_in "page has no placeholder" "$WORK/page.html" "__DEN_"
else bad "GET / failed"; fi
if curl -fsS "http://localhost:$PORT/api/server-info" -o "$WORK/api.json"; then
  expect_in "GET /api/server-info" "$WORK/api.json" '"pid"'
  # The MCP server reads it to tell an older web server from a missing route.
  expect_in "GET /api/server-info has Den's version" "$WORK/api.json" "\"version\":\"$DEN_VERSION\""
else bad "GET /api/server-info failed"; fi
# Den's CHANGELOG is an engine file: served from node_modules, not the dist.
if curl -fsS "http://localhost:$PORT/api/changelog" -o "$WORK/changelog.json"; then
  expect_in "GET /api/changelog reads Den's CHANGELOG" "$WORK/changelog.json" '"version"'
else bad "GET /api/changelog failed"; fi
# The graph's layout library is vendored from node_modules (no CDN), and the
# graph's own modules ship in the package.
if curl -fsS "http://localhost:$PORT/vendor/elk.bundled.js" -o "$WORK/elk.js"; then
  expect_in "GET /vendor/elk.bundled.js serves elkjs from the install" "$WORK/elk.js" "ELK"
else bad "GET /vendor/elk.bundled.js failed"; fi
for m in graph.js graph-model.js panel.js graph.css; do
  curl -fsS "http://localhost:$PORT/$m" -o /dev/null && ok "GET /$m" || bad "GET /$m failed"
done
# The Agents tab (AG-4a-term): its page and xterm.js from the install (no
# CDN); its list answers with or without the PTY module (without it,
# backend.available is false and the page says so).
for m in agents agents-page.js agent-start.js vendor/xterm.mjs vendor/xterm.css vendor/addon-fit.mjs vendor/addon-web-links.mjs term-input.js term-drop.js; do
  curl -fsS "http://localhost:$PORT/$m" -o /dev/null && ok "GET /$m" || bad "GET /$m failed"
done
if curl -fsS "http://localhost:$PORT/api/sessions" -o "$WORK/sessions.json"; then
  if [ "${DIST_SMOKE_OMIT_OPTIONAL:-}" = "1" ]; then
    expect_in "GET /api/sessions: den-pty unavailable" "$WORK/sessions.json" '"available":false'
  else
    expect_in "GET /api/sessions: den-pty available" "$WORK/sessions.json" '"available":true'
  fi
else bad "GET /api/sessions failed"; fi
WEB_LOG="$ACME_HOME/logs/acme/web.log"
if [ -f "$WEB_LOG" ]; then
  ok "ACME_HOME holds the state dir ($WEB_LOG)"
  if grep -inE 'warn|error|⚠' "$WEB_LOG" >"$WORK/web-warn.txt"; then
    bad "web server log has warnings/errors:"
    head -20 "$WORK/web-warn.txt" | sed 's/^/       /'
  else ok "web server log is clean"; fi
else bad "no web log under ACME_HOME"; fi
expect_in "page carries the UI marker" "$WORK/page.html" '<meta name="den-ui" content="1">'
expect_in "web log shows Den's version" "$WEB_LOG" "v$(node -p "require('$DEN/package.json').version")"
expect_not_in "web log shows no example name" "$WEB_LOG" "Shop"
# SEC-1a: web.secret (0600) in ACME_HOME; a mutation needs the CLI's token
# (from `web token --print`, never echoed) or the page's Origin and CSRF.
if [ -f "$ACME_HOME/web.secret" ] && [ "$(stat -c %a "$ACME_HOME/web.secret" 2>/dev/null || stat -f %Lp "$ACME_HOME/web.secret")" = "600" ]; then
  ok "web.secret is 0600 in ACME_HOME"
else bad "no 0600 web.secret in ACME_HOME"; fi
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  --data '{"editor":null}' "http://localhost:$PORT/api/settings")"
[ "$code" = "403" ] && ok "POST /api/settings without a token: 403" || bad "POST /api/settings without a token answered $code"
code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: evil.example" "http://localhost:$PORT/api/health")"
[ "$code" = "421" ] && ok "a rebinding Host: 421" || bad "a rebinding Host answered $code"
SEC_TOKEN="$(cd "$DIST" && ./bin/acme web token --print 2>/dev/null)"
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SEC_TOKEN" --data '{"editor":null}' "http://localhost:$PORT/api/settings")"
SEC_TOKEN=""
[ "$code" = "200" ] && ok "POST /api/settings with \`acme web token --print\`: 200" || bad "POST /api/settings with the CLI token answered $code"
# SEC-1b: `web login` prints a one-time link (never echoed here) that the
# server swaps for a session cookie, once.
SEC_LINK="$(cd "$DIST" && ./bin/acme web login --no-wait --port "$PORT" 2>/dev/null)"
SEC_HDR="$(curl -sS -o /dev/null -D - -H 'Sec-Fetch-Site: none' "$SEC_LINK")"
again="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Sec-Fetch-Site: none' "$SEC_LINK")"
SEC_LINK=""
if [[ "$SEC_HDR" == HTTP/*" 303"* ]] &&
  grep -qi "^set-cookie: den_session_$PORT=[^;]*; Path=/; HttpOnly; SameSite=Strict" <<<"$SEC_HDR" &&
  [ "$again" = "401" ]; then
  ok "\`acme web login\`'s link signs in once (303 and a session cookie; 401 the second time)"
else bad "\`acme web login\`'s link didn't sign in once (second use answered $again)"; fi
SEC_HDR=""
# SEC-1 (Ward, 2026-11-06): no sign-in on loopback, shell-grade included:
# the page's Origin and CSRF token (never echoed) reach an agent start.
# The edge counts as local when its X-Forwarded-For says this machine; a
# client it can't place (none, 0.4.5) or another machine signs in.
SEC_CSRF="$(curl -sS -H 'Sec-Fetch-Site: same-origin' "http://localhost:$PORT/api/session" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).csrf||""))}catch{}})')"
SEC_BODY="$WORK/agent-start.json"
code="$(curl -sS -o "$SEC_BODY" -w '%{http_code}' -X POST -H "Origin: http://localhost:$PORT" \
  -H "X-Den-CSRF: $SEC_CSRF" -H 'Content-Type: application/json' --data '{}' \
  "http://localhost:$PORT/api/workspaces/main/agents")"
SEC_CSRF=""
if [ -n "$code" ] && [ "$code" != "401" ] && [ "$code" != "403" ] && ! grep -q signin_required "$SEC_BODY"; then
  ok "agent start on localhost needs no sign-in (past the checks: $code)"
else bad "agent start on localhost answered $code (a sign-in or a refused check)"; fi
code="$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: acme.acme.localhost" \
  -H "X-Forwarded-For: 127.0.0.1" "http://localhost:$PORT/api/settings")"
[ "$code" = "200" ] && ok "the edge hostname from this machine needs no sign-in: 200" ||
  bad "the edge hostname from this machine answered $code"
code="$(curl -sS -o "$SEC_BODY" -w '%{http_code}' -H "Host: acme.acme.localhost" "http://localhost:$PORT/api/settings")"
if [ "$code" = "401" ] && grep -q signin_required "$SEC_BODY"; then
  ok "the edge hostname for a client it can't place needs a sign-in: 401 signin_required"
else bad "the edge hostname with no X-Forwarded-For answered $code"; fi
code="$(curl -sS -o "$SEC_BODY" -w '%{http_code}' -H "Host: acme.acme.localhost" \
  -H "X-Forwarded-For: 203.0.113.7" "http://localhost:$PORT/api/settings")"
if [ "$code" = "401" ] && grep -q signin_required "$SEC_BODY"; then
  ok "the edge hostname for another machine needs a sign-in: 401 signin_required"
else bad "the edge hostname for another machine without a session answered $code"; fi
run web-restart ./bin/acme web restart --no-open --port "$PORT"
run web-down ./bin/acme web down --port "$PORT"
port_free() { ! (lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1); }
if port_free "$PORT"; then
  ok "web down frees the port"
  PORT=""
else bad "web down left port $PORT listening"; fi
stop_web # anything still on the port (a failed down) is stopped here
PORT=""

say "linked engine checkout (npm i <den checkout>)"
LINKED="$WORK/linked"
cp -R "$DEN/examples/distribution" "$LINKED"
(cd "$LINKED" && npm install --no-audit --no-fund --silent "$DEN") >"$WORK/linked-install.out" 2>&1 ||
  {
    cat "$WORK/linked-install.out"
    exit 1
  }
[ -L "$LINKED/node_modules/@monster-orange/den" ] && ok "engine is a link to the checkout" ||
  bad "engine is not linked"
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"localhost",()=>{console.log(s.address().port);s.close()})')"
DIST_SAVED="$DIST"
DIST="$LINKED"
run linked-web-up ./bin/acme web up --no-open --port "$PORT"
run linked-web-down ./bin/acme web down --port "$PORT"
if port_free "$PORT"; then
  ok "linked: web down frees the port"
  PORT=""
else bad "linked: web down left port $PORT listening"; fi
stop_web
DIST="$DIST_SAVED"
PORT=""

echo
if [ "$fails" -eq 0 ]; then
  echo "dist-smoke: all checks passed"
else
  echo "dist-smoke: $fails failure(s); work dir $WORK"
  exit 1
fi
