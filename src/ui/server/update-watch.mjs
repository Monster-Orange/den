/**
 * SRV-1b: the watch over a Den update, and its rollback.
 *
 * `den_update` installs the new Den, then restarts. Nothing the new Den
 * runs can be trusted to undo a bad version, so the old (good) Den copies
 * this file out of the engine, into its state dir, and starts it on its
 * own before the restart. It needs nothing but node: no tsx, no Den
 * modules (npm install is replacing them as it runs).
 *
 *   node watch.mjs <plan.json>
 *
 * The plan (written by den-update.ts, 0600, no secrets):
 *   { port, to, from, fromPid, waitMs, pollMs?, root, backups: [{ saved,
 *     path }], npm: [cmd, ...args], restart: [cmd, ...args], stateFile,
 *     restartMarker: { path, marker } }
 *
 * It waits up to waitMs for this Den's /api/server-info to answer the new
 * version from a new pid. Then it writes { state: "good" } and exits.
 * Otherwise it puts the saved pin files back, runs npm install (the old
 * version again), leaves a restart note saying why, restarts, and waits
 * for the old version: { state: "rolled_back" }, or "rollback_failed" when
 * even that doesn't come back. Every state goes to stateFile.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeJson(file, v) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function say(state, extra = {}) {
  writeJson(plan.stateFile, {
    state,
    from: plan.from,
    to: plan.to,
    at: new Date().toISOString(),
    ...extra,
  });
}

function info() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port: plan.port,
        path: "/api/server-info",
        timeout: 3000,
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(b) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/**
 * Until `deadline`: the server answers `version` from a pid other than
 * `notPid`. `last` is the last answer from a new pid only: the old server
 * answering before it stops says nothing about the new one (gate
 * 0.4.44-dev.0).
 */
async function upOn(version, notPid, deadline) {
  let last = null;
  while (Date.now() < deadline) {
    const i = await info();
    if (i && i.pid !== notPid) last = i;
    if (i && i.version === version && i.pid !== notPid) return { ok: true, i };
    await sleep(plan.pollMs ?? 1000);
  }
  return { ok: false, last };
}

function run(argv) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: plan.root,
    encoding: "utf8",
    timeout: 10 * 60_000,
  });
  return {
    code: r.status,
    tail: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`
      .trim()
      .split("\n")
      .slice(-5)
      .join("\n"),
  };
}

const start = Date.now();
say("watching");
const up = await upOn(plan.to, plan.fromPid, start + plan.waitMs);
if (up.ok) {
  say("good", { pid: up.i.pid });
  process.exit(0);
}

const seen = up.last
  ? `it answered ${up.last.version ?? "?"} (pid ${up.last.pid ?? "?"})`
  : "nothing new answered on its port";
const why = `Den ${plan.to} wasn't up within ${Math.round(plan.waitMs / 1000)} s (${seen})`;
say("rolling_back", { why });
for (const b of plan.backups) {
  if (b.saved) fs.copyFileSync(b.saved, b.path);
  else fs.rmSync(b.path, { force: true });
}
const npm = run(plan.npm);
if (npm.code !== 0) {
  say("rollback_failed", {
    why: `${why}; npm install of ${plan.from} failed: ${npm.tail}`,
  });
  process.exit(1);
}
// The old Den, once up, tells the agent that asked (SRV-1a's note).
writeJson(plan.restartMarker.path, {
  ...plan.restartMarker.marker,
  reason: `${why}, so Den rolled back to ${plan.from}`,
  fromVersion: plan.to,
  // The new Den's pid, when it answered at all; never the old one's.
  fromPid: up.last?.pid ?? 0,
  rolledBack: true,
  at: new Date().toISOString(),
});
const before = (await info())?.pid ?? 0;
run(plan.restart);
const back = await upOn(plan.from, before, Date.now() + plan.waitMs);
say(back.ok ? "rolled_back" : "rollback_failed", {
  why,
  ...(back.ok ? { pid: back.i.pid } : {}),
});
process.exit(back.ok ? 0 : 1);
