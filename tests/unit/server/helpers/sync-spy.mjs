/**
 * Preload for the web server (`node --import <this> --import tsx ...`) that
 * records the synchronous fs and child_process calls one request makes.
 *
 * A request sent with the header `x-sync-spy: 1` runs inside an
 * AsyncLocalStorage context; every sync call made from that context (its
 * whole async continuation, not timers started elsewhere) is recorded with
 * the first Den frame that made it. `GET /__sync-spy` returns the record
 * and clears it. Nothing else changes: every other request is untouched.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import cp from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

const als = new AsyncLocalStorage();
let calls = [];

/** The first stack frame in Den's src/ (not this file, not node). */
function denCaller() {
  const lines = new Error().stack.split("\n").slice(3);
  for (const l of lines) {
    const m = /\(?((?:\/|file:)[^():]*\/src\/[^():]+):(\d+)/.exec(l);
    if (m && !m[1].includes("node_modules")) {
      const fn = /at (?:async )?([^\s(]+) \(/.exec(l)?.[1] ?? "(anon)";
      return `${fn} ${m[1].replace(/^.*\/src\//, "src/")}`;
    }
  }
  return "(no Den frame)";
}

function wrap(mod, name) {
  const orig = mod[name];
  if (typeof orig !== "function") return;
  mod[name] = function (...args) {
    if (als.getStore())
      calls.push({
        fn: name,
        arg: String(args[0] ?? "").slice(0, 200),
        caller: denCaller(),
      });
    return orig.apply(this, args);
  };
}

for (const n of [
  "readdirSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "readFileSync",
  "realpathSync",
  "accessSync",
  "opendirSync",
])
  wrap(fs, n);
for (const n of ["spawnSync", "execSync", "execFileSync"]) wrap(cp, n);

const origCreate = http.createServer;
http.createServer = function (...args) {
  const handler = args.find((a) => typeof a === "function");
  const wrapped = (req, res) => {
    if (req.url === "/__sync-spy") {
      const out = calls;
      calls = [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
      return;
    }
    if (req.headers["x-sync-spy"] === "1")
      return als.run(true, () => handler(req, res));
    return handler(req, res);
  };
  return origCreate.apply(
    this,
    args.map((a) => (a === handler ? wrapped : a)),
  );
};
syncBuiltinESMExports();
