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
import { redactSecrets } from "./redact.js";

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

/**
 * A writer for serverLog: (kind, text, onStdout), where `onStdout` says
 * whether serverLog already wrote the line to stdout.
 */
export function webLogWriter(o: {
  stdoutIsFile: () => boolean;
  writeStdout: (s: string) => void;
  path: () => string;
}): (kind: string, text: string, onStdout: boolean) => void {
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
    } catch {
      // Best effort: the ring has the line.
    }
  };
}
