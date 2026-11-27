/**
 * Test folders in the home folder. The Docker edge suites need
 * one there (Docker Desktop and OrbStack share only the home folder with
 * their VM): each makes it under ~/.den-test-docker with shareTmp, named
 * for its jest run (`r<run>-<prefix>`), and removes it in its afterAll.
 *
 * CommonJS, so the ESM teardown and ts-jest suites both load it.
 * Global teardown (global-teardown.mjs) calls homeStrays when the run ends:
 *   - `mine`: this run's folders still there. A suite skipped its cleanup
 *     or never reached it; the run fails, naming them, and they are removed.
 *   - `ended`: folders of runs that have ended (their pid is gone), and the
 *     older ones made straight in the home folder (`.den-test-*`). Listed,
 *     with the line that removes them, never removed: they may hold what a
 *     person wants to look at.
 * Another run's folder is left alone while that run lives: other checkouts
 * run their tests at the same time, with the same home folder.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SHARE = ".den-test-docker";
const TAGGED = /^r(\d+)-/;

/** A new folder for one suite, under <home>/.den-test-docker, named for its run. */
function shareTmp({ home, prefix, run }) {
  const base = path.join(home, SHARE);
  // Another run's teardown may remove the empty share folder in between.
  for (let i = 0; ; i++) {
    fs.mkdirSync(base, { recursive: true });
    try {
      return fs.mkdtempSync(path.join(base, `r${run}-${prefix}`));
    } catch (e) {
      if (e?.code !== "ENOENT" || i >= 2) throw e;
    }
  }
}

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * This run's folders left (removed now, unless `keep`), then the share
 * folder if it's empty; and the ended runs' folders, kept. Paths are
 * relative to `home`.
 */
function homeStrays({ home, run, keep = false }) {
  const base = path.join(home, SHARE);
  const mine = [];
  const ended = [];
  for (const n of list(base)) {
    const m = TAGGED.exec(n);
    if (m && m[1] === String(run)) mine.push(`${SHARE}/${n}`);
    else if (!m || !alive(m[1])) ended.push(`${SHARE}/${n}`);
  }
  for (const n of list(home))
    if (n.startsWith(".den-test-") && n !== SHARE) ended.push(n);
  if (!keep)
    for (const p of mine)
      fs.rmSync(path.join(home, p), { recursive: true, force: true });
  try {
    fs.rmdirSync(base); // only when empty
  } catch {
    /* not empty, or not there */
  }
  return { mine, ended };
}

module.exports = { SHARE, shareTmp, homeStrays };
