/**
 * One teardown for every browser suite (issue 233).
 *
 * A browser suite's afterAll closes, in this order:
 *
 * 1. every browser context (the ones given, and every one each browser still
 *    has): its routes are dropped first (`unrouteAll` with `ignoreErrors`,
 *    so a route handler still waiting on an answer cannot hold the close),
 *    then the context is closed;
 * 2. the browsers;
 * 3. the servers, in the order given: a test's Den server (a child process,
 *    stopped with its process group), an in-process server (its open
 *    connections are closed first: a bare `close()` waits for every
 *    keep-alive socket and event stream to end, and an event stream never
 *    ends by itself), or anything with `stop()` or `close()`;
 * 4. `after` (temp dirs).
 *
 * Every step runs even when an earlier one fails; the first failure is
 * thrown at the end. The hook's time limit is the browser suites' setting
 * (DEN_BROWSER_TEST_TIMEOUT_MS, tests/setup.ts), never a number here.
 *
 * `bareTeardowns` is the check (tests/unit/suite-teardown.test.ts): a
 * browser suite that closes anything in an afterAll without this helper.
 */
import { ChildProcess } from "child_process";
import * as net from "net";
import type { Browser, BrowserContext } from "playwright";
import { stopServer } from "./child-servers.js";

type Maybe<T> = T | null | undefined;

/** Something a browser suite stops after its browsers. */
export type SuiteServer = Maybe<
  | ChildProcess
  | net.Server
  | { stop(): unknown }
  | { close(): unknown }
  | (() => unknown)
>;

export interface BrowserSuiteParts {
  contexts?: Iterable<Maybe<BrowserContext>>;
  browsers?: Iterable<Maybe<Browser>>;
  servers?: Iterable<SuiteServer>;
  /** Runs last (temp dirs). */
  after?: () => unknown;
}

/** Close an in-process server: its open connections first, then it. */
function closeNetServer(s: net.Server): Promise<void> {
  const h = s as net.Server & { closeAllConnections?: () => void };
  h.closeAllConnections?.();
  return new Promise<void>((r) => s.close(() => r()));
}

async function stopOne(s: NonNullable<SuiteServer>): Promise<void> {
  if (typeof s === "function") await s();
  else if (s instanceof ChildProcess) await stopServer(s);
  else if (s instanceof net.Server) await closeNetServer(s);
  else if ("stop" in s && typeof s.stop === "function") await s.stop();
  else if ("close" in s && typeof s.close === "function") await s.close();
}

export async function closeBrowserSuite(
  parts: BrowserSuiteParts,
): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  };
  const browsers = [...(parts.browsers ?? [])].filter((b): b is Browser => !!b);
  const contexts = new Set<BrowserContext>();
  for (const c of parts.contexts ?? []) if (c) contexts.add(c);
  for (const b of browsers) for (const c of b.contexts()) contexts.add(c);
  // A context that is closed already, or whose browser went away, has
  // nothing left to close: those errors are not the suite's.
  await Promise.all(
    [...contexts].map(async (c) => {
      await c.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      await c.close().catch(() => {});
    }),
  );
  await Promise.all(browsers.map((b) => attempt(() => b.close())));
  for (const s of parts.servers ?? []) if (s) await attempt(() => stopOne(s));
  if (parts.after) await attempt(parts.after);
  if (errors.length) throw errors[0];
}

/** Each `afterAll(` call in `src`: its text and line. */
function afterAllCalls(src: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  const re = /\bafterAll\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) break;
    }
    out.push({
      text: src.slice(m.index, i + 1),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

/** Comments out of the way (a comment may name a call). */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/**
 * Where a browser suite's source closes outside `closeBrowserSuite`: each
 * afterAll that closes or stops something without it, and a suite that
 * opens a browser and never tears it down with it. Empty when it's clean.
 */
export function bareTeardowns(source: string): string[] {
  const src = code(source);
  const found: string[] = [];
  let helped = false;
  for (const { text, line } of afterAllCalls(src)) {
    if (/\bcloseBrowserSuite\s*\(/.test(text)) {
      helped = true;
      continue;
    }
    if (/\.(close|stop|destroy)\s*\(|\bstopServer\s*\(/.test(text))
      found.push(`line ${line}: an afterAll closes without closeBrowserSuite`);
  }
  if (!helped && /\.(launch|connect)\s*\(/.test(src))
    found.push("it opens a browser and no afterAll calls closeBrowserSuite");
  return found;
}
