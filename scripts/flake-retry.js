/**
 * A pull request's test run, with one retry of the files that failed, and
 * every pass on retry written down as a flake (never silent).
 *
 *   node scripts/flake-retry.js -- <jest args and files>
 *
 * Runs jest once (with --json to a temp file). All green: done. Red: the
 * failed test FILES run once more, alone (the same flags; no --shard, no
 * other files). A file that passes on retry is flaky: it goes into
 *   - the job summary, a "Flaky on retry" table;
 *   - flaky-on-retry.json (FLAKE_RETRY_OUT), which CI uploads as an
 *     artifact: file, the tests that failed first, sha, run, job, Node;
 *   - a warning annotation when tests/quarantine.json has no entry for the
 *     file (the list at the PR's head, so one the PR adds counts). It
 *     warns; it never blocks.
 * The step's exit code is the retry's: a file red twice still blocks.
 *
 * Why files, not jest's retryTimes: a retried test reruns in the same
 * worker, beside the same server and browser page its first try left
 * behind; a file reruns in a fresh worker, as on a re-run of the job. A
 * file is also what tests/quarantine.json and flake-evidence.mjs work in.
 *
 * Only ci.yml's pull request jobs call this. A push to main and the
 * release run jest directly: no retry, every failure blocks.
 *
 * FLAKE_RETRY_JEST overrides the jest command (the tests use a fake one).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";

const requireHere = createRequire(path.join(process.cwd(), "package.json"));

/** Relative path, forward slashes. */
function rel(file, root) {
  return path
    .relative(root, path.resolve(root, file))
    .split(path.sep)
    .join("/");
}

/** jest --json results → the failed files: [{ file, tests: [full names] }]. */
export function failedFiles(results, root = process.cwd()) {
  return (results.testResults ?? [])
    .filter((t) => t.status === "failed")
    .map((t) => ({
      file: rel(t.name ?? t.testFilePath, root),
      tests: (t.assertionResults ?? [])
        .filter((a) => a.status === "failed")
        .map((a) => a.fullName),
    }));
}

/** The first run's args, for the retry: its flags (no --shard), and these files. */
export function retryArgs(args, files) {
  const flags = args.filter(
    (a) => a.startsWith("-") && !/^--shard(=|$)/.test(a),
  );
  return [...flags, ...files];
}

/** The quarantined files at this checkout (tests/quarantine.json). */
function quarantinedFiles(root) {
  try {
    const q = requireHere(path.join(root, "tests", "quarantine.cjs"));
    return new Set(q.quarantinedFiles(q.loadQuarantine().entries));
  } catch {
    return new Set();
  }
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The "Flaky on retry" table for the job summary. */
export function summary(flaky) {
  if (!flaky.length) return "";
  return [
    "### Flaky on retry",
    "",
    `${flaky.length} test file(s) failed, then passed when run again on the same commit. They did not block; each is flaky until fixed or quarantined (tests/quarantine.json).`,
    "",
    "| File | Failed first | In quarantine.json |",
    "| --- | --- | --- |",
    ...flaky.map(
      (f) =>
        `| \`${cell(f.file)}\` | ${cell(f.tests.join("; ") || "(the file failed to run)")} | ${f.quarantined ? "yes" : "**no**"} |`,
    ),
    "",
  ].join("\n");
}

function jest(cmd, args, out, env) {
  const [bin, ...pre] = cmd;
  const r = spawnSync(bin, [...pre, ...args, "--json", `--outputFile=${out}`], {
    stdio: "inherit",
    env,
  });
  let results = {};
  try {
    results = JSON.parse(fs.readFileSync(out, "utf-8"));
  } catch {
    // no results: jest failed before running anything
  }
  return { code: r.status ?? 1, results };
}

/**
 * Run, retry the failed files once, record the flaky ones. Returns the
 * exit code for the step.
 */
export function run(args, env = process.env, root = process.cwd()) {
  const cmd = (env.FLAKE_RETRY_JEST || "npx jest --forceExit")
    .split(" ")
    .filter(Boolean);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "flake-retry-"));
  const first = jest(cmd, args, path.join(tmp, "first.json"), env);
  if (first.code === 0) return 0;
  const failed = failedFiles(first.results, root);
  // red with no failed file (a crash, a threshold): nothing to retry
  if (!failed.length) return first.code;
  console.log(
    `\nflake-retry: ${failed.length} file(s) failed; running them once more:\n  ${failed.map((f) => f.file).join("\n  ")}\n`,
  );
  const second = jest(
    cmd,
    retryArgs(
      args,
      failed.map((f) => f.file),
    ),
    path.join(tmp, "second.json"),
    env,
  );
  const stillRed = new Set(
    failedFiles(second.results, root).map((f) => f.file),
  );
  const ran = new Set(
    (second.results.testResults ?? []).map((t) =>
      rel(t.name ?? t.testFilePath, root),
    ),
  );
  const quarantined = quarantinedFiles(root);
  const flaky = failed
    .filter((f) => ran.has(f.file) && !stillRed.has(f.file))
    .map((f) => ({
      ...f,
      quarantined: quarantined.has(f.file),
      sha: env.FLAKE_RETRY_SHA || env.GITHUB_SHA || "",
      run: env.GITHUB_RUN_ID ? Number(env.GITHUB_RUN_ID) : null,
      attempt: env.GITHUB_RUN_ATTEMPT ? Number(env.GITHUB_RUN_ATTEMPT) : null,
      job: env.FLAKE_RETRY_JOB || env.GITHUB_JOB || "",
      node: process.version,
    }));
  if (flaky.length) {
    const outFile = path.resolve(
      root,
      env.FLAKE_RETRY_OUT || "flaky-on-retry.json",
    );
    let all = [];
    try {
      all = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    } catch {
      // the first flaky part of this job
    }
    fs.writeFileSync(
      outFile,
      JSON.stringify([...all, ...flaky], null, 2) + "\n",
    );
    const md = summary(flaky);
    if (env.GITHUB_STEP_SUMMARY)
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n");
    console.log(md);
    for (const f of flaky)
      if (!f.quarantined)
        console.log(
          `::warning file=${f.file}::Flaky on retry: ${f.file} failed, then passed when run again. Fix it, or add it to tests/quarantine.json with evidence (node scripts/flake-evidence.mjs ${env.GITHUB_RUN_ID ?? "<run id>"}).`,
        );
  }
  return second.code;
}

if (/[\\/]flake-retry\.js$/.test(process.argv[1] ?? "")) {
  const argv = process.argv.slice(2);
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  process.exitCode = run(args);
}
