/**
 * `--json` for setup commands an agent drives (ON-2): stdout carries exactly
 * one JSON object, and everything a command would print for a person goes
 * to stderr instead, so an agent can parse stdout and still show the log.
 */

/** Print one JSON object on stdout (one line, newline-terminated). */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Thrown in place of process.exit while quietStdout runs. */
export class ExitRequested extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
    this.name = "ExitRequested";
  }
}

/**
 * Run `fn` with console.log/info and process.stdout.write sent to stderr,
 * and process.exit turned into a thrown ExitRequested (so the caller still
 * prints its JSON). Everything is restored afterwards.
 */
export async function quietStdout<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const info = console.info;
  const write = process.stdout.write;
  const exit = process.exit;
  const toErr = (...a: unknown[]) => console.error(...a);
  console.log = toErr;
  console.info = toErr;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...x: unknown[]) => boolean)(
      chunk,
      ...rest,
    )) as typeof process.stdout.write;
  process.exit = ((code?: number) => {
    throw new ExitRequested(code ?? 0);
  }) as typeof process.exit;
  try {
    return await fn();
  } finally {
    console.log = log;
    console.info = info;
    process.stdout.write = write;
    process.exit = exit;
  }
}
