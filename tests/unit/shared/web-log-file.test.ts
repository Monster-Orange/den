/**
 * Issue 1344: the server's lifecycle, warn and error lines always reach
 * its own log file (web.log), whatever its stdout is, and never twice.
 *  - stdout a file (`web up` and a service send it to web.log): the line
 *    goes to stdout, once, also under --silent.
 *  - stdout a terminal or a pipe: the line is also appended to the
 *    install's web.log.
 * Other kinds (a request line, info) are left as they were. A secret in a
 * line never reaches the file. Invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  WEB_LOG_KINDS,
  stdoutLine,
  webLogPath,
  webLogWriter,
} from "../../../src/shared/web-log-file.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1344-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LINE =
  "  10:00:00  fixture person signed in (live checks, a test install)";

function writer(stdoutIsFile: boolean) {
  const stdout: string[] = [];
  const file = webLogPath(tmp, "acme");
  const w = webLogWriter({
    stdoutIsFile: () => stdoutIsFile,
    writeStdout: (s) => void stdout.push(s),
    path: () => file,
  });
  const onDisk = () =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
  return { w, stdout, file, onDisk };
}

describe("issue 1344: the server's own log file", () => {
  it("web.log sits under the state folder's logs, per CLI name", () => {
    expect(webLogPath("/s", "acme")).toBe(
      path.join("/s", "logs", "acme", "web.log"),
    );
    expect([...WEB_LOG_KINDS].sort()).toEqual(["error", "lifecycle", "warn"]);
  });

  it("stdout a file, the line not written there (--silent): written to stdout once", () => {
    const x = writer(true);
    for (const kind of ["lifecycle", "warn", "error"]) x.w(kind, LINE, false);
    expect(x.stdout).toEqual([`${LINE}\n`, `${LINE}\n`, `${LINE}\n`]);
    // Never by its path as well: stdout is the file.
    expect(x.onDisk()).toBe("");
  });

  it("stdout a file, the line already written there: nothing more", () => {
    const x = writer(true);
    x.w("lifecycle", LINE, true);
    expect(x.stdout).toEqual([]);
    expect(x.onDisk()).toBe("");
  });

  it("stdout a terminal or a pipe: appended to web.log, written there or not", () => {
    const x = writer(false);
    x.w("lifecycle", LINE, true);
    x.w("warn", "  ⚠ held", false);
    expect(x.stdout).toEqual([]);
    expect(x.onDisk()).toBe(`${LINE}\n  ⚠ held\n`);
    expect(fs.statSync(path.dirname(x.file)).mode & 0o077).toBe(0);
  });

  it("other kinds are left as they were", () => {
    for (const isFile of [true, false]) {
      const x = writer(isFile);
      x.w("info", "GET /api/status 200", false);
      x.w("request", "GET / 200", false);
      expect(x.stdout).toEqual([]);
      expect(x.onDisk()).toBe("");
    }
  });

  it("a secret in a line never reaches the file", () => {
    for (const isFile of [true, false]) {
      const x = writer(isFile);
      x.w(
        "error",
        "failed: Authorization: Bearer abcDEF123456.xyz-_~+/=",
        false,
      );
      const got = isFile ? x.stdout.join("") : x.onDisk();
      expect(got).toContain("failed:");
      expect(got).not.toContain("abcDEF123456");
    }
  });

  it("an existing web.log wider than 0600 is tightened on the first line", () => {
    const x = writer(false);
    fs.mkdirSync(path.dirname(x.file), { recursive: true });
    fs.writeFileSync(x.file, "before\n", { mode: 0o644 });
    fs.chmodSync(x.file, 0o644);
    x.w("lifecycle", LINE, false);
    expect(fs.statSync(x.file).mode & 0o777).toBe(0o600);
    expect(x.onDisk()).toBe(`before\n${LINE}\n`);
  });

  it("issue 1368: the server's own stdout line is redacted too", () => {
    const got = stdoutLine(
      "failed: Authorization: Bearer abcDEF123456.xyz-_~+/=",
    );
    expect(got).toContain("failed:");
    expect(got).not.toContain("abcDEF123456");
    expect(got.endsWith("\n")).toBe(true);
    expect(stdoutLine(LINE)).toBe(`${LINE}\n`);
  });

  it("a file it can't write never throws", () => {
    const w = webLogWriter({
      stdoutIsFile: () => false,
      writeStdout: () => {},
      path: () => path.join("/dev/null", "no", "web.log"),
    });
    expect(() => w("error", LINE, false)).not.toThrow();
  });
});
