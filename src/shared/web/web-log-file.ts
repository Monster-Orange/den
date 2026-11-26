/**
 * Issue 1344: the web server's lifecycle, warn and error lines always
 * reach its own log file, web.log, whatever its stdout is.
 *
 * `web up` and a service start the server with web.log as its stdout and
 * stderr, and `web up` passes --silent by default. Before this, serverLog
 * wrote to stdout only when not silent, so a silent server's lifecycle
 * lines (the fixture person's sign-in among them) reached no file.
 *  - stdout a regular file: the line goes to stdout, once: also under
 *    --silent, and never again when serverLog already wrote it there.
 *  - stdout a terminal or a pipe (a person's terminal, a test harness):
 *    the line is also appended to <state>/logs/<cli>/web.log, the file
 *    `web up` uses.
 * Other kinds (request lines, info) are left as they were. Each line is
 * passed through redactSecrets first. A file it can't write never stops
 * the server: the in-memory ring still has the line.
 */
import * as fs from "fs";
import * as path from "path";
import { redactSecrets } from "../redact.js";

/** The kinds that always reach web.log. */
export const WEB_LOG_KINDS: ReadonlySet<string> = new Set([
  "lifecycle",
  "warn",
  "error",
]);

/** web.log, as `web up` names it: <state>/logs/<cli>/web.log. */
export function webLogPath(stateDir: string, cli: string): string {
  return path.join(stateDir, "logs", cli, "web.log");
}

/** Whether `fd` (default stdout) is a regular file. */
export function fdIsFile(fd = 1): boolean {
  try {
    return fs.fstatSync(fd).isFile();
  } catch {
    return false;
  }
}

// ANSI SGR escapes (ESC = 0x1b): a control character, on purpose.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Issue 1368: serverLog's own stdout line (web.log under `web up` and a
 * service), passed through redactSecrets as every other log path is. The
 * check reads the line without its color codes, so a secret split by
 * them is caught; such a line is written plain. A line with no secret
 * keeps its colors.
 */
export function stdoutLine(msg: string): string {
  const plain = msg.replace(ANSI_RE, "");
  const safe = redactSecrets(plain);
  return `${safe === plain ? redactSecrets(msg) : safe}\n`;
}

/**
 * A writer for serverLog: (kind, text, onStdout), where `onStdout` says
 * whether serverLog already wrote the line to stdout.
 */
export function webLogWriter(o: {
  stdoutIsFile: () => boolean;
  writeStdout: (s: string) => void;
  path: () => string;
}): (kind: string, text: string, onStdout: boolean) => void {
  // A web.log made wider before (another tool, an older Den) is
  // tightened to 0600 on its first line here, once per file per run.
  const tightened = new Set<string>();
  return (kind, text, onStdout) => {
    if (!WEB_LOG_KINDS.has(kind)) return;
    try {
      const line = `${redactSecrets(text)}\n`;
      if (o.stdoutIsFile()) {
        if (!onStdout) o.writeStdout(line);
        return;
      }
      const file = o.path();
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(file, line, { mode: 0o600 });
      if (!tightened.has(file)) {
        tightened.add(file);
        fs.chmodSync(file, 0o600);
      }
    } catch {
      // Best effort: the ring has the line.
    }
  };
}
