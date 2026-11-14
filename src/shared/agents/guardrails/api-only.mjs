/**
 * D47: services an agent may reach only through their API. A service's
 * manifest says `agents: api_only` (and may name `data_paths:` and an
 * OrbStack `machine:`); Den writes the rules to a file the PreToolUse hook
 * reads on each call, and this module says whether a tool call goes around
 * the API: into the service's containers or volumes, its data paths, or
 * its machine.
 *
 * It is a guardrail, not a security boundary. It reads the words of a
 * command the way a shell would split them, through `sh -c`, `$( )`,
 * `env`, `sudo`, `xargs` and the like, but a program that calls the Docker
 * API itself, or a container id typed in place of its name, gets past it.
 * The hard boundary is an agent that can't reach that Docker engine.
 *
 * Plain Node, node:* only: it runs inside the hook on every call.
 *
 * Rules file (JSON):
 *   { "services": [ { "name": "hub", "project": "hub",
 *       "containers": ["hub-db"], "volumes": ["hub_data"],
 *       "composeServices": ["api", "db"], "composeVolumes": ["data"],
 *       "paths": ["/abs/data"], "machine": "hub-vm" } ] }
 * `name` is what the agent is told; `project` is its compose project: its
 * containers are `<project>-<service>-<n>` and its volumes
 * `<project>_<volume>` for the compose services and volumes listed, and
 * `containers`/`volumes` are names its compose files give outright. It is
 * the service instance, matched by name, never by where a command runs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The rules in `file`, or null (no file, or not rules). */
export function loadRules(file) {
  if (!file) return null;
  try {
    const r = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!r || !Array.isArray(r.services) || !r.services.length) return null;
    return r;
  } catch {
    return null;
  }
}

const base = (w) => String(w).slice(String(w).lastIndexOf("/") + 1);
const list = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

function expand(p, cwd, home) {
  let f = String(p);
  if (home && (f === "~" || f.startsWith("~/")))
    f = path.join(home, f.slice(1));
  else if (f.startsWith("$HOME/") && home) f = path.join(home, f.slice(6));
  return path.resolve(cwd || "/", f);
}

const under = (p, root) =>
  p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * 0.4.46: the container engines whose CLI is Docker's equal (run, exec,
 * cp, compose, volumes, and `<engine> raw …`), and the folders they keep
 * VM disks and volumes in. Den's defaults; the rules file's `engines` and
 * `engineDirs` (the agents.api_only_engines setting) add to them.
 */
export const DEFAULT_ENGINES = [
  "docker",
  "docker-compose",
  "podman",
  "nerdctl",
  "container",
  "kiri",
];
export const DEFAULT_ENGINE_DIRS = [
  "~/OrbStack",
  "~/.orbstack",
  "~/.colima",
  "~/.lima",
  "~/.kiri",
  "~/Kiri",
  "~/.local/share/containers",
  "~/Library/Containers/com.docker.docker",
];
const engineSet = (rules) =>
  new Set([...DEFAULT_ENGINES, ...list(rules.engines)]);

/** The protected paths: each service's data paths, and the engines' folders. */
function protectedPaths(rules, home) {
  const out = [];
  const dirs = [...DEFAULT_ENGINE_DIRS, ...list(rules.engineDirs)];
  for (const s of rules.services) {
    for (const p of list(s.paths))
      out.push({ path: expand(p, "/", home), service: s.name });
    if (home)
      for (const d of dirs)
        out.push({ path: expand(d, "/", home), service: s.name });
  }
  return out;
}

/** The service a path is under, or null. */
export function pathService(p, rules, opts = {}) {
  if (!rules || typeof p !== "string" || !p) return null;
  const abs = expand(p, opts.cwd, opts.home);
  for (const x of protectedPaths(rules, opts.home))
    if (under(abs, x.path)) return x.service;
  return null;
}

const reEsc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does a container, volume or project name belong to service `s`? By name
 * only, never by where a command runs: the project itself, its compose
 * services' containers (`<project>-<service>-<n>`), its compose volumes
 * (`<project>_<volume>`), and names its compose files give outright. A
 * project that only shares the prefix (`vault-dev` beside `vault`) is not
 * it. With no compose services known, any `<project>-…`/`<project>_…`.
 */
function owns(s, name) {
  const n = String(name).replace(/^\//, "");
  if (!n) return false;
  const proj = String(s.project || s.name || "");
  if (list(s.containers).includes(n) || list(s.volumes).includes(n))
    return true;
  if (!proj) return false;
  if (n === proj) return true;
  const svcs = list(s.composeServices);
  const vols = list(s.composeVolumes);
  if (!svcs.length && !vols.length)
    return n.startsWith(`${proj}-`) || n.startsWith(`${proj}_`);
  const p = reEsc(proj);
  if (
    svcs.length &&
    new RegExp(`^${p}[-_](?:${svcs.map(reEsc).join("|")})(?:[-_]\\d+)?$`).test(
      n,
    )
  )
    return true;
  return (
    vols.length > 0 &&
    new RegExp(`^${p}_(?:${vols.map(reEsc).join("|")})$`).test(n)
  );
}

/** The service whose compose project is exactly `project`. */
const projectOwner = (rules, project) =>
  rules.services.find((s) => String(s.project || s.name) === project)?.name ??
  null;

/**
 * The project a `docker compose` call acts on, as compose picks it: -p,
 * then COMPOSE_PROJECT_NAME, then the compose file's top-level `name:`,
 * then the project directory's name.
 */
function composeProject(project, dir, files, ctx) {
  if (project) return project;
  const where = expand(dir || ".", ctx.cwd, ctx.home);
  const candidates = files.length
    ? files.map((f) => expand(f, ctx.cwd, ctx.home))
    : [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
      ].map((f) => path.join(where, f));
  for (const f of candidates) {
    let text;
    try {
      text = fs.readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    const m = /^name:\s*["']?([^"'\s#]+)/m.exec(text);
    if (m) return m[1];
    break;
  }
  return path
    .basename(where)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
}

const ownerOf = (rules, name) =>
  rules.services.find((s) => owns(s, name))?.name ?? null;

const machineOf = (rules, name) =>
  rules.services.find((s) => s.machine && s.machine === name)?.name ?? null;

/** A host or Docker endpoint that is a declared machine's. */
function hostMachine(rules, h) {
  const v = String(h);
  for (const s of rules.services) {
    if (!s.machine) continue;
    const m = s.machine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`(^|[@/])${m}\\.orb\\.local(:|/|$)`).test(v) ||
      new RegExp(`(^|//)${m}@orb(:|/|$)`).test(v)
    )
      return s.name;
  }
  return null;
}

// Docker's global options that take a value.
const DOCKER_GLOBAL_VAL = new Set([
  "-c",
  "--context",
  "-H",
  "--host",
  "--config",
  "-l",
  "--log-level",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
// Options with a value, for the subcommands read here.
const EXEC_VAL = new Set([
  "-e",
  "--env",
  "--env-file",
  "-u",
  "--user",
  "-w",
  "--workdir",
  "--detach-keys",
]);
const RUN_VAL = new Set([
  "-e",
  "--env",
  "--env-file",
  "-u",
  "--user",
  "-w",
  "--workdir",
  "--name",
  "-p",
  "--publish",
  "--network",
  "--net",
  "--entrypoint",
  "-h",
  "--hostname",
  "--platform",
  "-l",
  "--label",
  "--restart",
  "--pull",
  "--cpus",
  "-m",
  "--memory",
  "--add-host",
  "--dns",
  "--ulimit",
  "--cap-add",
  "--cap-drop",
  "--device",
  "--gpus",
  "--ipc",
  "--pid",
  "--shm-size",
  "--stop-signal",
  "--tmpfs",
  "--log-driver",
  "--log-opt",
]);

/** The first operand after options (`val`: options that take a value). */
function firstOperand(args, val) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "--") return args[j + 1] ?? null;
    if (a.startsWith("-")) {
      if (!a.includes("=") && val.has(a)) j++;
      continue;
    }
    return a;
  }
  return null;
}

/** Volume and bind sources of `docker run|create` (-v, --mount, --volumes-from). */
function runSources(args) {
  const out = { volumes: [], paths: [], from: [] };
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    let v = null;
    let kind = null;
    for (const [flag, k] of [
      ["-v", "v"],
      ["--volume", "v"],
      ["--mount", "m"],
      ["--volumes-from", "f"],
    ]) {
      if (a === flag) {
        v = args[++j] ?? "";
        kind = k;
      } else if (a.startsWith(`${flag}=`)) {
        v = a.slice(flag.length + 1);
        kind = k;
      } else if (
        flag === "-v" &&
        a.startsWith("-v") &&
        a.length > 2 &&
        a[2] !== "-"
      ) {
        v = a.slice(2);
        kind = k;
      }
      if (kind) break;
    }
    if (!kind) {
      // The image, then the command: no more options of docker's.
      if (!a.startsWith("-")) break;
      if (!a.includes("=") && RUN_VAL.has(a)) j++;
      continue;
    }
    if (kind === "f") out.from.push(v.split(":")[0]);
    else if (kind === "v") {
      const src = v.split(":")[0];
      (src.startsWith("/") || src.startsWith(".") || src.startsWith("~")
        ? out.paths
        : out.volumes
      ).push(src);
    } else {
      const kv = Object.fromEntries(
        v.split(",").map((x) => {
          const i = x.indexOf("=");
          return i < 0 ? [x, ""] : [x.slice(0, i), x.slice(i + 1)];
        }),
      );
      const src = kv.source ?? kv.src ?? "";
      if (src) (kv.type === "bind" ? out.paths : out.volumes).push(src);
    }
  }
  return out;
}

/**
 * Why this docker call goes around an api_only service, or null.
 * `env`: the stage's VAR=value words, then the hook's own environment.
 */
function dockerReason(words, rules, ctx) {
  const env = ctx.env;
  let j = 1;
  let context = env.DOCKER_CONTEXT ?? "";
  let host = env.DOCKER_HOST ?? "";
  const isCompose = base(words[0]) === "docker-compose";
  for (; !isCompose && j < words.length; j++) {
    const a = words[j];
    if (!a.startsWith("-")) break;
    const [flag, eq] = a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, null];
    if (DOCKER_GLOBAL_VAL.has(flag)) {
      const v = eq ?? words[++j] ?? "";
      if (flag === "-c" || flag === "--context") context = v;
      if (flag === "-H" || flag === "--host") host = v;
    }
  }
  const m = machineOf(rules, context) ?? hostMachine(rules, host);
  if (m) return { service: m, what: `Docker on ${m}'s machine` };
  let sub = isCompose ? "compose" : words[j];
  let rest = isCompose ? words.slice(1) : words.slice(j + 1);
  if (sub === "container" || sub === "volume") {
    const op = rest[0];
    if (sub === "volume") {
      if (!["inspect", "rm", "cp", "export"].includes(op)) return null;
      for (const v of rest.slice(1).filter((x) => !x.startsWith("-"))) {
        const s = ownerOf(rules, v);
        if (s) return { service: s, what: `docker volume ${op} ${v}` };
      }
      return null;
    }
    sub = op;
    rest = rest.slice(1);
  }
  if (["exec", "attach", "export", "commit", "diff", "top"].includes(sub)) {
    const c = firstOperand(rest, EXEC_VAL);
    const s = c && ownerOf(rules, c);
    return s ? { service: s, what: `docker ${sub} ${c}` } : null;
  }
  if (sub === "cp") {
    for (const a of rest.filter((x) => !x.startsWith("-"))) {
      const i = a.indexOf(":");
      if (i <= 0) continue;
      const s = ownerOf(rules, a.slice(0, i));
      if (s) return { service: s, what: `docker cp ${a}` };
    }
    return null;
  }
  if (sub === "run" || sub === "create") {
    const src = runSources(rest);
    for (const v of [...src.volumes, ...src.from]) {
      const s = ownerOf(rules, v);
      if (s) return { service: s, what: `docker ${sub} with ${v}` };
    }
    for (const p of src.paths) {
      const s = pathService(p, rules, ctx);
      if (s) return { service: s, what: `docker ${sub} with ${p}` };
    }
    return null;
  }
  if (sub === "compose") return composeReason(rest, rules, ctx);
  return null;
}

/**
 * An engine's command (any listed engine is Docker's equal; `<engine> raw
 * …` is its own command), and the wrappers that run one inside a VM:
 * `lima <cmd>`, `limactl shell <vm> <cmd>`, `colima nerdctl [--] …`,
 * `colima ssh [--] <cmd>`. Null when it is none of them, or it passes.
 */
function engineReason(words, rules, ctx, depth = 0) {
  if (depth > 4 || !words.length) return null;
  const c = base(words[0]);
  const again = (w) => engineReason(w, rules, ctx, depth + 1);
  if (c === "lima") return again(words.slice(1));
  if (c === "limactl") {
    const i = words.indexOf("shell");
    if (i < 0) return null;
    let k = i + 1;
    while (k < words.length && words[k].startsWith("-")) k++;
    return again(words.slice(k + 1));
  }
  if (c === "colima") {
    let rest = words.slice(2);
    if (words[1] === "nerdctl") {
      if (rest[0] === "--") rest = rest.slice(1);
      return again(["nerdctl", ...rest]);
    }
    if (words[1] === "ssh") {
      const d = rest.indexOf("--");
      return again(d >= 0 ? rest.slice(d + 1) : rest);
    }
    return null;
  }
  if (c === "orb" || c === "orbctl") return orbReason(words, rules);
  if (engineSet(rules).has(c))
    return dockerReason(
      words[1] === "raw" ? [words[0], ...words.slice(2)] : words,
      rules,
      ctx,
    );
  return null;
}

/** `docker compose …` / `docker-compose …` against a service's project. */
function composeReason(args, rules, ctx) {
  let project = ctx.env.COMPOSE_PROJECT_NAME ?? "";
  let dir = "";
  const files = [];
  let j = 0;
  for (; j < args.length; j++) {
    const a = args[j];
    if (!a.startsWith("-")) break;
    const [flag, eq] = a.includes("=")
      ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]
      : [a, null];
    const takes = [
      "-p",
      "--project-name",
      "-f",
      "--file",
      "--project-directory",
      "--env-file",
      "--profile",
      "--ansi",
      "--parallel",
      "--progress",
    ];
    if (takes.includes(flag)) {
      const v = eq ?? args[++j] ?? "";
      if (flag === "-p" || flag === "--project-name") project = v;
      if (flag === "--project-directory") dir = v;
      if (flag === "-f" || flag === "--file") {
        files.push(v);
        if (!dir) dir = path.dirname(v);
      }
    }
  }
  const sub = args[j];
  if (!["exec", "cp", "run", "attach"].includes(sub)) return null;
  const p = composeProject(project, dir, files, ctx);
  const s = p ? projectOwner(rules, p) : null;
  return s ? { service: s, what: `docker compose ${sub} on ${p}` } : null;
}

/** `orb` / `orbctl` aimed at a declared machine (or at none: the default). */
function orbReason(words, rules) {
  const machines = rules.services.filter((s) => s.machine);
  if (!machines.length) return null;
  let named = null;
  for (let j = 1; j < words.length; j++) {
    const a = words[j];
    if (a === "-m" || a === "--machine") named = words[j + 1] ?? "";
    else if (a.startsWith("--machine=")) named = a.slice(10);
    else if (/^-m./.test(a)) named = a.slice(2);
  }
  if (named !== null) {
    const s = machineOf(rules, named);
    return s ? { service: s, what: `${base(words[0])} on ${named}` } : null;
  }
  // No machine named: it runs in the default one, which may be this one.
  const sub = words.find((w, i) => i > 0 && !w.startsWith("-")) ?? "";
  const harmless = [
    "list",
    "ls",
    "info",
    "status",
    "version",
    "help",
    "logs",
    "start",
    "stop",
    "config",
    "update",
    "docker",
    "k8s",
    "default",
  ];
  if (harmless.includes(sub)) return null;
  // `orb shell <machine>` / `orbctl run <machine>`-style operands.
  for (const w of words.slice(1)) {
    const s = machineOf(rules, w);
    if (s) return { service: s, what: `${base(words[0])} ${sub} ${w}` };
  }
  return {
    service: machines.map((s) => s.name).join(", "),
    what: `${base(words[0])} ${sub || "(a shell)"} with no machine named (-m): it runs in the default machine`,
  };
}

/** ssh, scp, sftp, rsync to a declared machine. */
function sshReason(words, rules) {
  for (const w of words.slice(1)) {
    const s = hostMachine(rules, w);
    if (s) return { service: s, what: `${base(words[0])} to ${w}` };
  }
  return null;
}

// Wrappers whose operand is the command that really runs.
const WRAP = new Set([
  "sudo",
  "env",
  "nice",
  "nohup",
  "timeout",
  "xargs",
  "command",
  "exec",
  "time",
  "doas",
  "stdbuf",
  "caffeinate",
]);
// Wrapper options that take a value (sudo -u, timeout -k, xargs -I, …).
const WRAP_VAL = new Set([
  "-u",
  "-g",
  "-C",
  "-D",
  "-p",
  "-r",
  "-t",
  "-U",
  "-h",
  "-s",
  "-k",
  "-I",
  "-L",
  "-n",
  "-P",
  "-d",
  "-E",
  "-S",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Unwrap `sudo -u x env A=B timeout 5 docker …` to `docker …` and its env. */
function unwrap(words, assigns) {
  const env = [...assigns];
  let w = words;
  for (let guard = 0; guard < 8 && w.length; guard++) {
    const c = base(w[0]);
    if (!WRAP.has(c)) break;
    let j = 1;
    for (; j < w.length; j++) {
      const a = w[j];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) {
        env.push(a);
        continue;
      }
      if (a.startsWith("-")) {
        if (WRAP_VAL.has(a)) j++;
        continue;
      }
      if (c === "timeout" && /^\d/.test(a)) continue;
      break;
    }
    w = w.slice(j);
  }
  return { words: w, env };
}

/**
 * Why this Bash command goes around an api_only service, or null:
 * { service, what }. `parseShell` is the hook's own shell splitter.
 */
export function apiOnlyBash(command, rules, ctx, parseShell, depth = 0) {
  if (!rules || depth > 4) return null;
  let pipelines;
  try {
    pipelines = parseShell(String(command ?? ""));
  } catch {
    return null;
  }
  // Every directory a stage may run in: where the command starts, and
  // each place a cd or pushd before it goes (`cd svc && docker compose
  // exec …`, `(cd svc; …)`). The splitter flattens subshells, so a stage
  // is checked in all of them: a cd never gets a command past the rule.
  const cwds = [ctx.cwd];
  for (const stages of pipelines)
    for (const st of stages) {
      for (const cwd of [...new Set(cwds)]) {
        const r = stageReason(st, rules, { ...ctx, cwd }, parseShell, depth);
        if (r) return r;
      }
      const to = cdTarget(st.words);
      if (to !== null)
        for (const cwd of [...new Set(cwds)])
          cwds.push(expand(to, cwd, ctx.home));
    }
  return null;
}

/** Where a `cd` / `pushd` stage goes; null for anything else or `$VAR`. */
function cdTarget(words) {
  const c = base(words[0] ?? "");
  if (c !== "cd" && c !== "pushd") return null;
  const to = words.slice(1).find((w) => !/^-[LPe@]*$/.test(w));
  if (to === undefined) return "~";
  if (to === "-" || to.includes("$") || to.includes("`")) return null;
  return to;
}

/** One stage's reason, in `ctx.cwd`. */
function stageReason(st, rules, ctx, parseShell, depth) {
  // Command substitutions inside any word run too.
  for (const w of st.words) {
    for (const m of String(w).matchAll(/\$\(([\s\S]*)\)|`([^`]*)`/g)) {
      const r = apiOnlyBash(m[1] ?? m[2], rules, ctx, parseShell, depth + 1);
      if (r) return r;
    }
  }
  const { words, env } = unwrap(st.words, st.assigns ?? []);
  if (!words.length) return null;
  const c = base(words[0]);
  const envObj = { ...ctx.env };
  for (const a of env)
    envObj[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
  const here = { ...ctx, env: envObj };
  if (SHELLS.has(c)) {
    const i = words.findIndex((x, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(x));
    if (i > 0 && words[i + 1] !== undefined) {
      const r = apiOnlyBash(words[i + 1], rules, here, parseShell, depth + 1);
      if (r) return r;
    }
  }
  if (c === "eval") {
    const r = apiOnlyBash(
      words.slice(1).join(" "),
      rules,
      here,
      parseShell,
      depth + 1,
    );
    if (r) return r;
  }
  let r = engineReason(words, rules, here);
  if (!r && ["ssh", "scp", "sftp", "rsync", "mosh"].includes(c))
    r = sshReason(words, rules);
  if (r) return r;
  // Any word that is a path under a protected one: a read or a write.
  for (const w of [...words.slice(1), ...st.inputs]) {
    if (!/^[~/.$]/.test(w) && !w.includes("/")) continue;
    const s = pathService(w.replace(/^[^=]*=(?=[~/])/, ""), rules, here);
    if (s) return { service: s, what: `${c} on ${w}` };
  }
  return null;
}

// The tools that read or write a file, and the input that names it.
const PATH_TOOLS = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "path",
  Glob: "path",
};

/** Why this tool call goes around an api_only service, or null. */
export function apiOnlyDecision(input, rules, ctx, parseShell) {
  if (!rules || !input || typeof input !== "object") return null;
  const ti =
    input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input
      : {};
  if (input.tool_name === "Bash")
    return apiOnlyBash(ti.command, rules, ctx, parseShell);
  const key = PATH_TOOLS[input.tool_name];
  if (!key || typeof ti[key] !== "string") return null;
  const s = pathService(ti[key], rules, ctx);
  return s ? { service: s, what: `${input.tool_name} of ${ti[key]}` } : null;
}

/** The message the agent gets. */
export function apiOnlyMessage(r) {
  return (
    `Den blocked this: ${r.what} goes around ${r.service}, which agents may ` +
    `reach only through its API (agents: api_only). Use its API or its MCP ` +
    `tools instead. If you need something its API doesn't offer, ask the person.`
  );
}

/**
 * Append one line to the audit file: when, which agent, which tool and
 * service, and what (never the whole command: it may hold a secret).
 */
export function audit(file, r, input, env = process.env) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        at: new Date().toISOString(),
        kind: "api_only.denied",
        // The agent's id, from its session's DEN_AGENT=agent:<id>.
        agent: /^agent:(.+)$/.exec(env.DEN_AGENT ?? "")?.[1] ?? null,
        tool: input?.tool_name ?? null,
        service: r.service,
        what: String(r.what).slice(0, 200),
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* an audit that can't be written never unblocks the call */
  }
}

export const HOME = () => process.env.HOME || os.homedir();
