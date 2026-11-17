/**
 * Issue 397: with DEN_TEST_QUARANTINE set, a table of the quarantined tests
 * this run saw, each with its result, its issue and its age. It goes to
 * the job summary ($GITHUB_STEP_SUMMARY) when there is one, and to the log.
 *
 * "exclude" (the blocking run): each one is listed as left out.
 * "only" (the non-blocking step): each one passed, failed or was skipped.
 */
"use strict";
const fs = require("fs");
const q = require("./quarantine.cjs");

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

class QuarantineReporter {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
  }

  onRunComplete(_contexts, results) {
    const mode = q.quarantineMode();
    if (!mode) return;
    const doc = q.loadQuarantine();
    const rows = [];
    for (const file of results.testResults) {
      const rel = q.relPath(file.testFilePath, this.rootDir);
      const mine = doc.entries.filter((e) => q.relPath(e.file) === rel);
      if (!mine.length) continue;
      if (file.testExecError && mode === "only")
        rows.push({
          status: "failed",
          test: "(the file failed to run)",
          rel,
          e: mine[0],
        });
      for (const a of file.testResults) {
        const e = mine.find((x) => q.entryMatches(x, rel, a.fullName, a.title));
        if (!e) continue;
        const status =
          mode === "exclude"
            ? "left out (runs in the quarantine step)"
            : a.status === "pending"
              ? "skipped"
              : a.status;
        rows.push({ status, test: a.fullName, rel, e });
      }
    }
    const title =
      mode === "exclude"
        ? "Quarantined tests: left out of this blocking run"
        : "Quarantined tests: non-blocking run";
    const failed = rows.filter((r) => r.status === "failed").length;
    const lines = [
      `### ${title}`,
      "",
      rows.length
        ? `${rows.length} quarantined test(s) in this part${mode === "only" ? `, ${failed} failed` : ""}.`
        : "No quarantined test in this part.",
      "",
    ];
    if (rows.length) {
      lines.push("| Result | Test | File | Issue | Age (days) |");
      lines.push("| --- | --- | --- | --- | --- |");
      for (const r of rows)
        lines.push(
          `| ${cell(r.status)} | ${cell(r.test)} | ${cell(r.rel)} | #${r.e.issue} | ${q.ageDays(r.e.added)} |`,
        );
      lines.push("");
    }
    const md = lines.join("\n") + "\n";
    const summary = (process.env.GITHUB_STEP_SUMMARY ?? "").trim();
    if (summary) fs.appendFileSync(summary, md);
    process.stdout.write(`\n${md}`);
  }
}

module.exports = QuarantineReporter;
