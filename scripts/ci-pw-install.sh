#!/usr/bin/env bash
# Playwright's browsers and their system packages, for CI (ci.yml,
# release.yml and repeat.yml call only this;
# tests/unit/test-infra/pw-install.test.ts keeps it so).
#
# `npx playwright install --with-deps chromium webkit` hung twice until the
# job's 20-minute timeout: its apt part crawled from the Ubuntu mirror, a
# few kB/s, package after package. So the two parts run apart, each with
# its own time limit and one retry, and fail loudly after that:
#   1. `playwright install-deps chromium webkit`: the system packages (apt);
#   2. `playwright install chromium webkit`: the browsers. CI restores them
#      from a cache (~/.cache/ms-playwright, keyed by the OS and
#      Playwright's version), so this part is usually instant.
#
# The apt part runs as root, so a cut-off attempt can't kill it: it goes
# on holding dpkg's lock, and a retry right away fails at once ("Could not
# get lock", exit 100). Before the retry, the script waits (up to the same
# limit) until no apt or dpkg process is left.
#
# The limits are settings (seconds per attempt):
#   CI_PW_DEPS_SECONDS     the system packages, default 240
#   CI_PW_INSTALL_SECONDS  the browsers, default 90
#   CI_PW_BUSY_PATTERN     what a leftover apt run looks like (pgrep -f),
#                          default "apt-get|dpkg"
#
#   bash scripts/ci-pw-install.sh [browser ...]  install (default: chromium webkit)
#   bash scripts/ci-pw-install.sh version        print version=<Playwright's version> (the cache key)
set -u

if [ "${1:-}" = version ]; then
  v=$(node -p 'require("./package-lock.json").packages["node_modules/playwright"].version') || exit 1
  echo "version=$v"
  exit 0
fi

browsers=("$@")
[ ${#browsers[@]} -gt 0 ] || browsers=(chromium webkit)
for b in "${browsers[@]}"; do
  case "$b" in
    chromium | webkit | firefox) ;;
    *)
      echo "::error::not a Playwright browser: $b (chromium, webkit or firefox)" >&2
      exit 2
      ;;
  esac
done

deps_s=${CI_PW_DEPS_SECONDS:-240}
install_s=${CI_PW_INSTALL_SECONDS:-90}
for pair in "CI_PW_DEPS_SECONDS=$deps_s" "CI_PW_INSTALL_SECONDS=$install_s"; do
  case "${pair#*=}" in
    '' | *[!0-9]* | 0)
      echo "::error::${pair%%=*} is a number of seconds (got \"${pair#*=}\")" >&2
      exit 2
      ;;
  esac
done

# A cut-off apt run (root) lives on and holds dpkg's lock: wait for it.
wait_apt() {
  local limit=$1 pattern=${CI_PW_BUSY_PATTERN:-apt-get|dpkg} until
  pgrep -f "$pattern" >/dev/null 2>&1 || return 0
  echo "ci-pw-install: waiting for the cut-off apt run to finish (up to $limit s)"
  until=$(($(date +%s) + limit))
  while pgrep -f "$pattern" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$until" ] || break
    sleep 2
  done
}

# One part: up to two attempts, each cut off at its limit.
attempt() {
  local what=$1 limit=$2 setting=$3 n code start
  for n in 1 2; do
    start=$(date +%s)
    echo "ci-pw-install: npx playwright $what ${browsers[*]} (attempt $n, limit $limit s)"
    timeout --kill-after=10 "$limit" npx playwright "$what" "${browsers[@]}"
    code=$?
    if [ "$code" -eq 0 ]; then
      echo "ci-pw-install: $what done in $(($(date +%s) - start)) s"
      return 0
    fi
    if [ "$n" -eq 1 ]; then
      if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
        echo "::warning::playwright $what took over $limit s (cut off); retrying once"
      else
        echo "::warning::playwright $what failed (exit $code); retrying once"
      fi
      [ "$what" = install-deps ] && wait_apt "$limit"
    fi
  done
  echo "::error::playwright $what failed twice (limit $limit s each; exit $code). The mirror or the download is stuck: re-run the job, or raise $setting."
  return 1
}

attempt install-deps "$deps_s" CI_PW_DEPS_SECONDS || exit 1
attempt install "$install_s" CI_PW_INSTALL_SECONDS || exit 1
