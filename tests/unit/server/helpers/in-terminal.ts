/**
 * Sign-in: the CLI prints a sign-in link or code only to a terminal, so a
 * test that reads one runs the CLI in a terminal of its own (Den's PTY
 * module). What a terminal shows is stdout and stderr together: `text` is
 * that, without colours or carriage returns.
 */
import { spawn } from "child_process";
import { loadPty } from "../../../../src/shared/sessions/pty.js";

export interface InTerminal {
  /** Each new piece of what it shows, as it comes. */
  onText(fn: (all: string) => void): void;
  done: Promise<{ status: number; text: string }>;
}

// eslint-disable-next-line no-control-regex -- terminal escape codes
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g;

export function inTerminal(
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): InTerminal {
  const pty = loadPty();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.env))
    if (v !== undefined) env[k] = v;
  if (!pty.available) return viaScript(file, args, opts.cwd, env);
  const p = pty.factory(file, args, {
    cwd: opts.cwd,
    env,
    cols: 400,
    rows: 50,
  });
  let text = "";
  const fns: ((all: string) => void)[] = [];
  p.onData((d) => {
    text += d.toString("utf-8").replace(ANSI, "").replace(/\r/g, "");
    for (const fn of fns) fn(text);
  });
  const done = new Promise<{ status: number; text: string }>((r) =>
    p.onExit((e) => {
      // The last output can trail the exit by a moment.
      setTimeout(() => {
        p.close?.();
        r({ status: e.exitCode, text });
      }, 100);
    }),
  );
  return { onText: (fn) => fns.push(fn), done };
}

/**
 * Without the PTY module (an install that left it out): script(1), which
 * macOS and util-linux spell differently.
 */
function viaScript(
  file: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): InTerminal {
  const q = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
  const child = spawn(
    "script",
    process.platform === "darwin"
      ? ["-q", "/dev/null", file, ...args]
      : ["-qec", [file, ...args].map(q).join(" "), "/dev/null"],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let text = "";
  const fns: ((all: string) => void)[] = [];
  const take = (d: Buffer) => {
    text += d
      .toString("utf-8")
      .replace(ANSI, "")
      // eslint-disable-next-line no-control-regex -- terminal control bytes
      .replace(/[\r\x04\x08]/g, "");
    for (const fn of fns) fn(text);
  };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const done = new Promise<{ status: number; text: string }>((r) =>
    child.on("close", (status) => r({ status: status ?? 1, text })),
  );
  return { onText: (fn) => fns.push(fn), done };
}

/** The first line that is a link (http or https). */
export function linkIn(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^https?:\/\/\S+$/.test(l)) ?? ""
  );
}
