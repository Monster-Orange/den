#!/usr/bin/env node
/**
 * Issue 843: the `ci-ok` job's verdict. It reads NEEDS (the job's
 * `toJSON(needs)`) and exits 0 only when every job a pull request runs
 * passed, or was skipped because `pr` planned nothing for it: den-ui-nav
 * when no nav changed (`nav` isn't "true"), pr-shards when there are no
 * shards (`shards` is "[]"). A failure, a cancel, any other skip, or a job
 * missing from NEEDS fails it. The merge queue requires this one check, so
 * the ruleset never names a shard.
 */
const REQUIRED = ["fast", "pr", "den-ui-nav", "pr-shards"];

let needs;
try {
  needs = JSON.parse(process.env.NEEDS || "");
} catch {
  console.error("ci-ok: NEEDS is missing or isn't JSON (run it from CI).");
  process.exit(1);
}

const pr = needs.pr?.outputs ?? {};
const maySkip = {
  "den-ui-nav": pr.nav !== "true",
  "pr-shards": pr.shards === "[]",
};

let ok = true;
for (const job of REQUIRED) {
  const result = needs[job]?.result ?? "missing";
  const fine =
    result === "success" || (result === "skipped" && maySkip[job] === true);
  console.log(
    `${job}: ${result}${fine ? "" : result === "skipped" ? " (it had work to do)" : ""}`,
  );
  if (!fine) ok = false;
}
for (const job of Object.keys(needs))
  if (!REQUIRED.includes(job)) {
    console.log(`${job}: not checked by ci-ok (add it to REQUIRED)`);
    ok = false;
  }
process.exit(ok ? 0 : 1);
