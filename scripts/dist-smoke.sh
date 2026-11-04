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
# The throwaway install lives under $RUNNER_TEMP (CI) or $TMPDIR.
set -euo pipefail

DEN="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
WORK="$(mktemp -d "${BASE%/}/den-dist-smoke.XXXXXX")"
DIST="$WORK/acme"
export ACME_HOME="$WORK/acme-home"
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
}
trap stop_web EXIT

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
(cd "$DIST" && npm install --no-audit --no-fund --silent "$TARBALL") >"$WORK/install.out" 2>&1 ||
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

say "make (dry run) from the distribution root"
run make-help make help
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
else bad "GET /api/server-info failed"; fi
# Den's CHANGELOG is an engine file: served from node_modules, not the dist.
if curl -fsS "http://localhost:$PORT/api/changelog" -o "$WORK/changelog.json"; then
  expect_in "GET /api/changelog reads Den's CHANGELOG" "$WORK/changelog.json" '"version"'
else bad "GET /api/changelog failed"; fi
WEB_LOG="$ACME_HOME/logs/acme/web.log"
if [ -f "$WEB_LOG" ]; then
  ok "ACME_HOME holds the state dir ($WEB_LOG)"
  if grep -inE 'warn|error|⚠' "$WEB_LOG" >"$WORK/web-warn.txt"; then
    bad "web server log has warnings/errors:"
    head -20 "$WORK/web-warn.txt" | sed 's/^/       /'
  else ok "web server log is clean"; fi
else bad "no web log under ACME_HOME"; fi
run web-down ./bin/acme web down --port "$PORT"
PORT=""

echo
if [ "$fails" -eq 0 ]; then
  echo "dist-smoke: all checks passed"
else
  echo "dist-smoke: $fails failure(s); work dir $WORK"
  exit 1
fi
