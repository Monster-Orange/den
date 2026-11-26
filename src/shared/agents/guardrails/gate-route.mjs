/**
 * Issue 1264: an agent's test, typecheck or browser run goes through the
 * gate even when the agent starts it directly. Den's PreToolUse hook
 * (pretooluse.mjs) asks routeCommand about each Bash command: one that
 * runs a program on the list (gates.route_commands) is rewritten to run
 * whole under `gate run` (kind browser for Playwright, cpu otherwise), and
 * jest or vitest given no worker count gets the gate's share
 * (DEN_GATE_WORKERS, issue 1048), so no run starts cores − 1 workers.
 *
 * Only a single plain command is rewritten: one stage, no `;`, `&&`,
 * `||`, pipe, `&`, `$( )`, backticks, `<( )`, `>( )`, heredoc, comment or
 * line break (PR review: a wrapper hides the rest of a compound command
 * from the agent's own permission rules). The command's own text follows
 * `gate run … --` unchanged, so the same shell reads it the same way, and
 * a prefix rule still sees the program. Anything else stays as written:
 * one already under `gate run`, one the parser can't read, one with no
 * listed program. Plain JavaScript with no imports (the parser is passed
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

/**
 * Shell syntax that makes a command more than one plain command, outside
 * a fd copy such as 2>&1. Checked on the raw text, quotes and all: a `|`
 * inside quotes leaves the command as written too, which is safe.
 */
const COMPOUND = /[;&|`\n#]|\$\(|<\(|>\(|<</;
const FD_COPY = /\d*>&\d+|\d*<&\d+/g;

/** Whether `src` is a single plain command (see COMPOUND). */
export function plainCommand(src) {
  return !COMPOUND.test(String(src).replace(FD_COPY, ""));
}

/**
 * The words in front of a routed command: `<gate> --kind <kind> --`. A
 * launch builds its allow rules from the same words (den-claude.ts).
 */
export const gatePrefix = (gate, kind) => `${gate} --kind ${kind} --`;

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
  const src = String(command ?? "").trim();
  if (!gate || !programs || !programs.length || !src) return null;
  if (!plainCommand(src)) return null;
  let pipelines;
  try {
    pipelines = parse(src);
  } catch {
    return null;
  }
  if (pipelines.length !== 1 || pipelines[0].length !== 1) return null;
  const st = pipelines[0][0];
  if (st.background || gated(st.words)) return null;
  // The text must start with the stage's own first word: a leading
  // FOO=1 (which `gate run` would try to run) or a quoted first word stays
  // as written.
  if (src.split(/\s+/)[0] !== st.words[0]) return null;
  const h = matchEntry(st.words, programs);
  if (!h) return null;
  const kind = h.name === "playwright" ? "browser" : "cpu";
  let text = src;
  if (
    TAKES_WORKERS.has(h.name) &&
    !st.words.slice(h.at + 1).some((w) => SETS_WORKERS.test(w))
  ) {
    // Right after the program's word, where it stands once in the text; a
    // second place (a quoted name) leaves the count to the command.
    const word = st.words[h.at];
    const re = new RegExp(
      `(^|\\s)(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=\\s|$)`,
      "g",
    );
    const found = [...src.matchAll(re)];
    if (found.length === 1) {
      const end = found[0].index + found[0][1].length + found[0][2].length;
      text = `${src.slice(0, end)} ${WORKERS_FLAG}${src.slice(end)}`;
    }
  }
  return {
    command: `${gatePrefix(gate, kind)} ${text}`,
    kind,
    program: h.entry,
  };
}

/**
 * Issue 1264: the listed program a command runs anywhere in it (any
 * stage), as { program, kind }, or null: none, one already under
 * `gate run`, or one the parser can't read. The hook records a heavy run
 * it leaves alone by this: the list entry, never the arguments.
 */
export function heavyProgram(command, { programs, parse }) {
  const src = String(command ?? "");
  if (!programs || !programs.length || !src.trim()) return null;
  let pipelines;
  try {
    pipelines = parse(src);
  } catch {
    return null;
  }
  let hit = null;
  for (const stages of pipelines)
    for (const st of stages) {
      if (gated(st.words)) return null;
      const m = matchEntry(st.words, programs);
      if (m && (!hit || m.name === "playwright")) hit = m;
    }
  return hit
    ? {
        program: hit.entry,
        kind: hit.name === "playwright" ? "browser" : "cpu",
      }
    : null;
}

const ON_WORDS = new Set(["1", "yes", "on", "true"]);
const OFF_WORDS = new Set(["0", "no", "off", "false"]);

export function onOff(x) {
  if (typeof x === "boolean") return x;
  if (typeof x === "number") return x === 1 ? true : x === 0 ? false : null;
  if (typeof x !== "string") return null;
  const t = x.trim().toLowerCase();
  return ON_WORDS.has(t) ? true : OFF_WORDS.has(t) ? false : null;
}
