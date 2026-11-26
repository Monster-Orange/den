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

function record(file, dir, owner, fsObj = fs) {
  if (!file) return;
  try {
    fsObj.appendFileSync(file, `${real(dir)}\t${owner}\n`);
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
      const [dir, owner] = line.split("\t");
      if (!dir || !owner || !fsObj.existsSync(dir)) continue;
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

module.exports = {
  tempRoots,
  isTempDen,
  listFile,
  record,
  setTestFile,
  armTmpLeaks,
  leaksIn,
};
