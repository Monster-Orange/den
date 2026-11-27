const fs = require("fs");
const os = require("os");
const path = require("path");

const ARMED = Symbol.for("den.tmpLeaks");
const CURRENT = Symbol.for("den.tmpLeaks.file");

function real(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function tempRoots(env = process.env) {
  const roots = [os.tmpdir(), "/tmp", env.TMPDIR, env.RUNNER_TEMP];
  return [...new Set(roots.filter(Boolean).map(real))];
}

function isTempDen(dir, roots) {
  const abs = real(dir);
  return (
    path.basename(abs).startsWith("den-") && roots.includes(path.dirname(abs))
  );
}

function listFile(env = process.env, pid = process.pid) {
  if (!env.DEN_TEST_GLOBAL_STUBS) return null;
  return path.join(
    path.dirname(env.DEN_TEST_GLOBAL_STUBS),
    `tmp-made-${pid}.log`,
  );
}

function record(file, dir, owner, fsObj = fs, event = "made", at = Date.now()) {
  if (!file) return;
  try {
    fsObj.appendFileSync(file, `${real(dir)}\t${owner}\t${event}\t${at}\n`);
  } catch (e) {
    void e;
  }
}

function setTestFile(file, fsObj = fs) {
  fsObj[CURRENT] = file;
}

function armTmpLeaks(fsObj = fs, env = process.env) {
  if (fsObj[ARMED]) return;
  fsObj[ARMED] = true;
  const roots = tempRoots(env);
  const file = listFile(env);
  const note = (dir) => {
    if (typeof dir === "string" && isTempDen(dir, roots))
      record(file, dir, fsObj[CURRENT] || "unknown", fsObj);
  };
  const sync = fsObj.mkdtempSync;
  fsObj.mkdtempSync = function (...args) {
    const dir = sync.apply(this, args);
    note(dir);
    return dir;
  };
  const cb = fsObj.mkdtemp;
  fsObj.mkdtemp = function (...args) {
    const done = args[args.length - 1];
    if (typeof done === "function")
      args[args.length - 1] = (err, dir) => {
        if (!err) note(dir);
        done(err, dir);
      };
    return cb.apply(this, args);
  };
  const p = fsObj.promises.mkdtemp;
  fsObj.promises.mkdtemp = async function (...args) {
    const dir = await p.apply(this, args);
    note(dir);
    return dir;
  };
  const before = (dir) =>
    typeof dir === "string" && path.basename(dir).startsWith("den-")
      ? real(dir)
      : null;
  const gone = (abs) => {
    if (abs && isTempDen(abs, roots))
      record(file, abs, fsObj[CURRENT] || "unknown", fsObj, "removed");
  };
  for (const name of ["rmSync", "rmdirSync"]) {
    const orig = fsObj[name];
    fsObj[name] = function (dir, ...rest) {
      const abs = before(dir);
      const out = orig.call(this, dir, ...rest);
      gone(abs);
      return out;
    };
  }
  const rm = fsObj.rm;
  fsObj.rm = function (dir, ...rest) {
    const abs = before(dir);
    const done = rest[rest.length - 1];
    if (typeof done === "function")
      rest[rest.length - 1] = (err) => {
        if (!err) gone(abs);
        done(err);
      };
    return rm.call(this, dir, ...rest);
  };
  const prm = fsObj.promises.rm;
  fsObj.promises.rm = async function (dir, ...rest) {
    const abs = before(dir);
    await prm.call(this, dir, ...rest);
    gone(abs);
  };
}

function eventsIn(globalDir, fsObj = fs) {
  let names = [];
  try {
    names = fsObj.readdirSync(globalDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^tmp-made-\d+\.log$/.test(n)) continue;
    const text = fsObj.readFileSync(path.join(globalDir, n), "utf-8");
    for (const line of text.split("\n")) {
      const [dir, owner, event = "made", at = ""] = line.split("\t");
      if (dir && owner) out.push({ dir, owner, event, at: Number(at) || 0 });
    }
  }
  return out;
}

function historyIn(globalDir, fsObj = fs) {
  const h = new Map();
  for (const e of eventsIn(globalDir, fsObj)) {
    if (!h.has(e.dir)) h.set(e.dir, { made: [], removed: [] });
    const list =
      e.event === "removed" ? h.get(e.dir).removed : h.get(e.dir).made;
    list.push({ owner: e.owner, at: e.at });
  }
  return h;
}

function filesIn(dir, fsObj = fs) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try {
      names = fsObj.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      if (out.length >= 5000) return;
      const full = path.join(d, n.name);
      if (n.isDirectory()) walk(full);
      else {
        let at = 0;
        try {
          at = fsObj.lstatSync(full).mtimeMs;
        } catch {
          continue;
        }
        out.push({ rel: path.relative(dir, full), at });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.at - a.at || a.rel.localeCompare(b.rel));
}

function describeLeak(dir, history, fsObj = fs, max = 20) {
  const iso = (ms) => new Date(ms).toISOString();
  const h = history.get(dir);
  const made = h?.made[0];
  const removed = h?.removed[h.removed.length - 1];
  const head = !made
    ? "no record of it being made"
    : removed
      ? `made ${iso(made.at)} (${made.owner}); removed ${iso(removed.at)} (${removed.owner}): made again after its remove`
      : `made ${iso(made.at)} (${made.owner}); no fs remove of it was seen`;
  const files = filesIn(dir, fsObj);
  return [
    head,
    ...files.slice(0, max).map((f) => `${iso(f.at)}  ${f.rel}`),
    ...(files.length > max ? [`(${files.length - max} more)`] : []),
  ];
}

function leaksIn(globalDir, fsObj = fs) {
  const by = new Map();
  const own = new Set();
  let names = [];
  try {
    names = fsObj.readdirSync(globalDir);
  } catch {
    return { leaks: [], own: [] };
  }
  for (const n of names) {
    if (!/^tmp-made-\d+\.log$/.test(n)) continue;
    const text = fsObj.readFileSync(path.join(globalDir, n), "utf-8");
    for (const line of text.split("\n")) {
      const [dir, owner, event] = line.split("\t");
      if (!dir || !owner || event === "removed" || !fsObj.existsSync(dir))
        continue;
      if (owner === "setup") own.add(dir);
      else {
        if (!by.has(owner)) by.set(owner, new Set());
        by.get(owner).add(dir);
      }
    }
  }
  const leaks = [...by]
    .map(([file, dirs]) => ({ file, dirs: [...dirs].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { leaks, own: [...own].sort() };
}

function judge(leaks, baseline) {
  const allowed = (file) =>
    Number.isInteger(baseline[file]) ? baseline[file] : 0;
  return {
    over: leaks
      .filter((l) => l.dirs.length > allowed(l.file))
      .map((l) => ({ ...l, allowed: allowed(l.file) })),
    under: leaks
      .filter((l) => l.dirs.length < allowed(l.file))
      .map((l) => ({
        file: l.file,
        allowed: allowed(l.file),
        now: l.dirs.length,
      })),
  };
}

module.exports = {
  judge,
  tempRoots,
  isTempDen,
  listFile,
  record,
  setTestFile,
  armTmpLeaks,
  leaksIn,
  historyIn,
  describeLeak,
};
