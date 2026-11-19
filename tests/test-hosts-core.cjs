/**
 * Issue 501: the session hosts a test run starts, found by the tag on their
 * command line.
 *
 * A session host is a detached process (its own session and process group):
 * stopping the test, or the Den server or CLI that started it, never reaches
 * it. So every host a test starts carries a tag, `--tag=<tag>`:
 *
 *   den-test-<run>[@<test file>][~<owner>]
 *
 * - <run>: the jest run's id (DEN_TEST_RUN, global setup).
 * - <test file>: the file whose spawn led to it (tests/sentinel.ts adds it
 *   to every spawn that passes an env; a spawn without one has the run only).
 * - <owner>: the helper that owns it (tests/test-hosts.ts, or a Den server
 *   started by tests/child-servers.ts), which stops it.
 *
 * The tag is on the command line, not in the env, because macOS shows no
 * other process's env. A Den CLI or server passes DEN_HOST_TAG on to the
 * host it starts (src/ui/cli/sessions-command.ts, hostArgs); the test
 * helpers' host scripts get it as an argument.
 *
 * Nothing here looks at a process without this run's tag: other hosts on
 * the machine (real installs, other runs) are never touched. A person finds
 * leftover test hosts with `ps -ww -A -o pid,command | grep -- --tag=den-test-`.
 */
const { execFileSync } = require("child_process");

/** A host's command line: the CLI's `sessions host`, or a helper's *-host.ts. */
const HOST_RE = /\ssessions host(?=\s|$)|-host\.ts(?=\s|$)/;
const TAG_RE =
  /(?:^|\s)--tag[= ]den-test-(\d+)(?:@([^\s~]+))?(?:~([\w-]+))?(?=\s|$)/;

/** A file name as one word of a tag (sessions-command.ts's HOST_TAG_RE). */
function tagFile(file) {
  return String(file)
    .replace(/[^\w./-]/g, "_")
    .slice(-150);
}

/** The tag for `run`, and for `file` and `owner` when given. */
function hostTag(run, file, owner) {
  let tag = `den-test-${run}`;
  if (file) tag += `@${tagFile(file)}`;
  if (owner) tag += `~${owner}`;
  return tag;
}

/** The run's id a tag names, or null. */
function tagRun(tag) {
  const m = /^den-test-(\d+)/.exec(tag ?? "");
  return m ? m[1] : null;
}

/** The tagged hosts in `ps -o pid=,pgid=,command=` output. */
function parseHosts(ps) {
  const out = [];
  for (const line of String(ps).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || !HOST_RE.test(` ${m[3]}`)) continue;
    const t = TAG_RE.exec(m[3]);
    if (!t) continue;
    out.push({
      pid: Number(m[1]),
      pgid: Number(m[2]),
      run: t[1],
      file: t[2] ?? null,
      owner: t[3] ?? null,
      command: m[3],
    });
  }
  return out;
}

/**
 * Every live host with a test run's tag, any run's: for a report only
 * (global setup counts an earlier run's leftovers); never signalled.
 */
function anyRunHosts() {
  let ps = "";
  try {
    // den#143: the whole list, however busy the machine.
    ps = execFileSync("ps", ["-ww", "-A", "-o", "pid=,pgid=,command="], {
      encoding: "utf-8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  return parseHosts(ps).filter((h) => h.pid !== process.pid);
}

/**
 * The live hosts tagged with `want.run` (and `want.file`, `want.owner`
 * when given). Never one without the run's tag.
 */
function taggedHosts(want) {
  if (!want || !want.run) return [];
  return anyRunHosts().filter(
    (h) =>
      h.run === String(want.run) &&
      (want.file === undefined || h.file === want.file) &&
      (want.owner === undefined || h.owner === want.owner),
  );
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === "EPERM");
  }
}

/** Signal a host: its whole group when it leads one (it was started detached). */
function signal(h, sig) {
  try {
    process.kill(h.pgid === h.pid ? -h.pid : h.pid, sig);
  } catch {
    /* gone */
  }
}

/**
 * SIGTERM each host (its group), wait up to `graceMs` for it to end, then
 * SIGKILL what is left. Resolves once each is gone (or after the SIGKILL).
 */
async function stopHosts(hosts, graceMs = 5000) {
  for (const h of hosts) signal(h, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (hosts.some((h) => alive(h.pid)) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  for (const h of hosts) if (alive(h.pid)) signal(h, "SIGKILL");
}

/** Resolves with the hosts still alive after waiting up to `ms` for them to end. */
async function survivors(hosts, ms) {
  const deadline = Date.now() + ms;
  while (hosts.some((h) => alive(h.pid)) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  return hosts.filter((h) => alive(h.pid));
}

/**
 * DEN_TEST_HOST_GRACE_MS: how long the run's guard waits for a host to end
 * on its own (one a test is still stopping) before it counts as left
 * behind. 5000 when unset or not a number.
 */
function graceMs(env = process.env) {
  const raw = String(env.DEN_TEST_HOST_GRACE_MS ?? "").trim();
  return /^\d+$/.test(raw) ? Number(raw) : 5000;
}

module.exports = {
  anyRunHosts,
  graceMs,
  hostTag,
  parseHosts,
  stopHosts,
  survivors,
  tagFile,
  tagRun,
  taggedHosts,
};
