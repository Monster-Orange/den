import * as fs from "node:fs";
import * as path from "node:path";

const HINT =
  "Remove only the link first (`rm node_modules`, with no -r), then install: " +
  "this worktree gets its own folder, and the shared one is left alone.";

const words = (s) => new Set(s.split(" "));
const INSTALLERS = {
  npm: words(
    "ci clean-install ic install-clean isntall-clean install i in ins inst insta instal isnt isnta isntal isntall cit clean-install-test install-ci-test it install-test add prune uninstall un remove rm r unlink update up upgrade udpate dedupe ddp rebuild rb",
  ),
  pnpm: words(
    "install i install-test it add remove rm uninstall un prune update up upgrade rebuild rb",
  ),
  yarn: words(" install add remove upgrade"),
};
const DIR_FLAGS = new Set(["--prefix", "-C", "--dir", "--cwd"]);
const VALUED = new Set([
  ...DIR_FLAGS,
  "--loglevel",
  "-w",
  "--workspace",
  "--registry",
  "--cache",
  "--userconfig",
  "--globalconfig",
  "--tag",
  "--otp",
  "--scope",
  "--filter",
  "-F",
  "--modules-folder",
  "--mutex",
  "--network-timeout",
]);
const PASS = new Set(["time", "command", "nohup", "exec", "sudo", "doas"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const base = (w) => String(w).slice(String(w).lastIndexOf("/") + 1);
const opaque = (w) => /[$`]/.test(w);
const expand = (p, home) =>
  home && (p === "~" || p.startsWith("~/")) ? path.join(home, p.slice(1)) : p;

function linkTarget(dir) {
  const link = path.join(dir, "node_modules");
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  try {
    return fs.realpathSync(link);
  } catch {
    return path.resolve(dir, fs.readlinkSync(link));
  }
}

function skipOptions(a, valued) {
  let j = 0;
  while (j < a.length && a[j].startsWith("-") && a[j] !== "--") {
    if (valued.has(a[j])) j++;
    j++;
  }
  return a[j] === "--" ? j + 1 : j;
}

function unwrap(all) {
  let w = all;
  let dir = null;
  for (let n = 0; n < 16 && w.length; n++) {
    const c = base(w[0]);
    const a = w.slice(1);
    if (c === "env") {
      let j = 0;
      while (
        j < a.length &&
        (a[j].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[j]))
      ) {
        if (a[j] === "-C" || a[j] === "--chdir") dir = a[j + 1] ?? null;
        if (["-C", "--chdir", "-u", "--unset"].includes(a[j])) j++;
        j++;
      }
      w = a.slice(j);
    } else if (c === "nice")
      w = a.slice(skipOptions(a, new Set(["-n", "--adjustment"])));
    else if (c === "xargs")
      w = a.slice(
        skipOptions(
          a,
          new Set(["-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a"]),
        ),
      );
    else if (c === "npx")
      w = a.slice(skipOptions(a, new Set(["-p", "--package"])));
    else if (c === "corepack" || PASS.has(c))
      w = a.slice(skipOptions(a, new Set(["-u", "-g"])));
    else if (c === "npm" && ["exec", "x"].includes(a[skipOptions(a, VALUED)]))
      w = a.slice(skipOptions(a, VALUED) + 1).filter((x, i) => i || x !== "--");
    else if (SHELLS.has(c)) {
      const k = a.findIndex((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
      return k >= 0
        ? { script: a[k + 1] ?? "", dir }
        : { cmd: c, args: a, dir };
    } else if (c === "eval") return { script: a.join(" "), dir };
    else return { cmd: c, args: a, dir };
  }
  return { cmd: "", args: [], dir };
}

function subcommand(args) {
  const found = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a.startsWith("-")) {
      if (VALUED.has(a)) j++;
      continue;
    }
    found.push({ a, afterFlag: j > 0 && /^-/.test(args[j - 1]) });
  }
  return found;
}

function installer(cmd, args) {
  const set = INSTALLERS[cmd];
  if (!set) return null;
  const subs = subcommand(args);
  const hit =
    subs.length === 0
      ? set.has("")
      : set.has(subs[0].a) ||
        (subs[0].afterFlag && subs[1] !== undefined && set.has(subs[1].a));
  const vague = subs.length > 0 && opaque(subs[0].a);
  if (!hit && !vague) return null;
  let dir = null;
  for (let j = 0; j < args.length; j++) {
    const eq = /^(--prefix|--dir|--cwd)=(.+)$/.exec(args[j]);
    if (eq) dir = eq[2];
    else if (DIR_FLAGS.has(args[j])) dir = args[j + 1] ?? null;
  }
  return { dir, opaque: vague || args.some(opaque) };
}

const MODULES = /(^|\/)node_modules\/\*?$/;

function targets(cmd, args) {
  const inst = installer(cmd, args);
  if (inst) return [{ dir: inst.dir ?? ".", opaque: inst.opaque }];
  if (cmd === "git") {
    let dir = ".";
    let j = 0;
    while (args[j] === "-C") {
      dir = args[j + 1] ?? ".";
      j += 2;
    }
    if (args[j] !== "clean") return [];
    const flags = args.slice(j + 1).filter((a) => a.startsWith("-"));
    if (flags.some((a) => a === "--dry-run" || /^-[a-zA-Z]*n/.test(a)))
      return [];
    if (!flags.some((a) => /^-[a-zA-Z]*[xX]/.test(a))) return [];
    return [{ dir, opaque: opaque(dir) }];
  }
  const paths = (list) =>
    list.flatMap((a) =>
      MODULES.test(a) || (opaque(a) && a.includes("node_modules"))
        ? [{ dir: path.dirname(a.replace(/\/\*?$/, "")), opaque: opaque(a) }]
        : [],
    );
  if (cmd === "rm") {
    if (!args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive"))
      return [];
    return paths(args.filter((a) => !a.startsWith("-")));
  }
  if (cmd === "find") {
    if (!args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir"))
      return [];
    let j = 0;
    while (["-L", "-H", "-P"].includes(args[j])) j++;
    const starts = [];
    while (j < args.length && !/^[-(!]/.test(args[j])) starts.push(args[j++]);
    return paths(starts);
  }
  return [];
}

function unlinks(cmd, args) {
  if (cmd !== "rm") return [];
  return args
    .filter((a) => !a.startsWith("-") && /(^|\/)node_modules$/.test(a))
    .map((a) => path.dirname(a));
}

function scan(command, parse, ctx, depth) {
  let pipelines;
  try {
    pipelines = parse(command);
  } catch {
    return { at: ctx.here, opaque: true, shown: command };
  }
  for (const stages of pipelines)
    for (const st of stages) {
      const shown = st.words.join(" ");
      const u = unwrap(st.words);
      const here =
        u.dir === null || opaque(u.dir)
          ? ctx.here
          : path.resolve(ctx.here, expand(u.dir, ctx.home));
      const lost = ctx.lost || (u.dir !== null && opaque(u.dir));
      if (u.script !== undefined) {
        if (opaque(u.script) || depth > 4)
          return { at: here, opaque: true, shown };
        const inner = scan(u.script, parse, { ...ctx, here, lost }, depth + 1);
        if (inner) return inner;
        continue;
      }
      if ((u.cmd === "cd" || u.cmd === "pushd") && u.args[0] !== "-") {
        const to = u.args[0] ?? "~";
        if (opaque(to)) ctx.lost = true;
        else ctx.here = path.resolve(ctx.here, expand(to, ctx.home));
        continue;
      }
      for (const t of targets(u.cmd, u.args)) {
        if (lost || t.opaque) return { at: here, opaque: true, shown };
        const dir = path.resolve(here, expand(t.dir, ctx.home));
        if (!ctx.unlinked.has(dir) && linkTarget(dir))
          return { at: dir, opaque: false, shown };
      }
      for (const d of unlinks(u.cmd, u.args))
        if (!opaque(d))
          ctx.unlinked.add(path.resolve(here, expand(d, ctx.home)));
    }
  return null;
}

export function linkedModulesReason(command, parse, opts = {}) {
  const { cwd, home } = opts;
  const ctx = {
    here: path.resolve(cwd || "."),
    home,
    unlinked: new Set(),
    lost: false,
  };
  const hit = scan(String(command ?? ""), parse, ctx, 0);
  if (!hit || ctx.unlinked.has(hit.at)) return null;
  const target = linkTarget(hit.at);
  if (!target) return null;
  const short = (p) =>
    home && (p === home || p.startsWith(`${home}/`))
      ? `~${p.slice(home.length)}`
      : p;
  const link = short(path.join(hit.at, "node_modules"));
  const why = hit.opaque
    ? "Den can't tell where it installs or deletes (a `$`, a backquote or a script it can't read), so it may empty that folder"
    : "this would empty it";
  return `Den blocked \`${hit.shown}\`: ${link} is a link to ${short(target)}, a folder other worktrees share, and ${why}. ${HINT}`;
}
