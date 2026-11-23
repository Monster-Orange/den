/**
 * Issue 1264: an agent's test, typecheck or browser run goes through the
 * gate even when the agent starts it directly. Den's PreToolUse hook
 * (pretooluse.mjs) asks routeCommand about each Bash command: one that
 * runs a program on the list (gates.route_commands) is rewritten to run
 * whole under `gate run` (kind browser for Playwright, cpu otherwise), and
 * jest or vitest given no worker count gets the gate's share
 * (DEN_GATE_WORKERS, issue 1048), so no run starts cores − 1 workers.
 *
 * It never changes a command it isn't sure of: one already under
 * `gate run`, one the parser can't read, or one with no listed program
 * stays as it is. Plain JavaScript with no imports (the parser is passed
 * in), so the hook stays fast.
 */

/** The programs routed when the setting names none (issue 1264). */
export const ROUTE_DEFAULT = Object.freeze([
  "jest",
  "vitest",
  "tsc",
  "playwright",
  "npm test",
  "npm run test*",
]);

/** The flag jest and vitest get: the gate's share, one when it's unset. */
export const WORKERS_FLAG = "--maxWorkers=${DEN_GATE_WORKERS:-1}";

/** The runners in front of a program: `npx jest`, `pnpm exec vitest`. */
const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const RUNNER_SUB = { pnpm: ["exec", "dlx"], yarn: ["exec", "dlx"] };

/** A worker count the command sets already (jest and vitest both). */
const SETS_WORKERS =
  /^(?:-w|-i|--runInBand|--maxWorkers|--max-workers|--maxThreads|--max-threads|--poolOptions\.)/;

/** Programs whose worker count Den sets when the command doesn't. */
const TAKES_WORKERS = new Set(["jest", "vitest"]);

const base = (w) => String(w).slice(String(w).lastIndexOf("/") + 1);

/** A word for a single-quoted shell string. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The program a stage runs, past its runner (`npx -y jest` → jest), and
 * the index of that word; null when none.
 */
function programOf(words) {
  let i = 0;
  const w0 = base(words[0] ?? "");
  if (RUNNERS.has(w0)) {
    i = 1;
    while (i < words.length && words[i].startsWith("-")) i++;
  } else if (RUNNER_SUB[w0] && RUNNER_SUB[w0].includes(words[1])) i = 2;
  return i < words.length ? { name: base(words[i]), at: i } : null;
}

/** Whether this stage starts `gate run` (Den's own CLI, or a tool's that wraps it). */
function gated(words) {
  for (let i = 0; i + 1 < words.length; i++)
    if (words[i] === "gate" && words[i + 1] === "run") return i <= 2;
  return false;
}

/**
 * The list entry this stage matches, or null. A plain entry is a program
 * (`jest`); `npm test` and `npm run test*` match npm's own forms, `*` any
 * end of the script's name.
 */
function matchEntry(words, programs) {
  const p = programOf(words);
  if (!p) return null;
  for (const e of programs) {
    const parts = String(e).trim().split(/\s+/);
    if (parts.length === 1) {
      if (p.name === parts[0]) return { entry: e, name: p.name, at: p.at };
      continue;
    }
    if (base(words[0] ?? "") !== parts[0]) continue;
    const rest = words.slice(1, parts.length);
    if (rest.length !== parts.length - 1) continue;
    const ok = parts.slice(1).every((x, k) => {
      const w = rest[k];
      if (x.endsWith("*")) return w.startsWith(x.slice(0, -1));
      return w === x;
    });
    if (ok) return { entry: e, name: parts.join(" "), at: 0 };
  }
  return null;
}

/**
 * The gated form of `command`, or null to leave it as it is.
 * `gate`: the shell words that start a gate run (`'/…/den' gate run`);
 * empty turns routing off. `programs`: gates.route_commands. `parse`: the
 * hook's shell parser (pretooluse.mjs parseShell).
 * Returns { command, kind, program }.
 */
export function routeCommand(command, { gate, programs, parse }) {
  const src = String(command ?? "");
  if (!gate || !programs || !programs.length || !src.trim()) return null;
  let pipelines;
  try {
    pipelines = parse(src);
  } catch {
    return null;
  }
  const hits = [];
  for (const stages of pipelines)
    for (const st of stages) {
      if (gated(st.words)) return null;
      const m = matchEntry(st.words, programs);
      if (m) hits.push({ ...m, words: st.words });
    }
  if (!hits.length) return null;
  const kind = hits.some((h) => h.name === "playwright") ? "browser" : "cpu";
  let text = src;
  const h = hits[0];
  if (
    hits.length === 1 &&
    TAKES_WORKERS.has(h.name) &&
    !h.words.slice(h.at + 1).some((w) => SETS_WORKERS.test(w))
  ) {
    // Only where the program's word stands once in the text: a second
    // place (another run, a quoted name) leaves the count to the command.
    const word = h.words[h.at];
    const re = new RegExp(
      `(^|[\\s;&|(])(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=\\s|$)`,
      "g",
    );
    const found = [...src.matchAll(re)];
    if (found.length === 1) {
      const end = found[0].index + found[0][1].length + found[0][2].length;
      text = `${src.slice(0, end)} ${WORKERS_FLAG}${src.slice(end)}`;
    }
  }
  return {
    command: `${gate} --kind ${kind} --label ${shq(`agent: ${h.name}`)} -- bash -c ${shq(text)}`,
    kind,
    program: h.entry,
  };
}
