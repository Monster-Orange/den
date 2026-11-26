/**
 * Issue 1299: a failed read of the sessions file under load can drop every
 * other session at the next sign-in. The store cached a failed read as an
 * empty store, and the next write saved only its own entry.
 *
 *  1. A read that fails is never cached: once the file reads again, every
 *     session is found.
 *  2. A write after a failed read is refused (create, code use, an end),
 *     and the file keeps every session.
 *  3. The refusal is reported with the error's code, never the file's
 *     contents or a session's secret.
 *  4. A file that reads whole but isn't valid is moved aside (kept for a
 *     person to look at), reported, and the store starts empty.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SessionStoreUnreadable,
  WebSessionStore,
  webSessionsPath,
} from "../../../src/shared/web/web-session.js";

const T0 = Date.UTC(2026, 10, 23, 6, 0, 0);
let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1299-")));
});
afterEach(() => {
  try {
    fs.chmodSync(webSessionsPath(tmp), 0o600);
  } catch {
    /* gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const secret = randomBytes(32);
function store() {
  const problems: string[] = [];
  const kinds: string[] = [];
  const s = new WebSessionStore({
    stateDir: () => tmp,
    secret: () => secret,
    now: () => T0,
    onProblem: (m, kind) => {
      problems.push(m);
      kinds.push(kind);
    },
  });
  return { s, problems, kinds };
}

/**
 * Another writer (the CLI, another request's save) changes the file, then
 * the next read fails: the store has to read, and can't.
 */
function changedThenUnreadable() {
  store().s.create({ host: "other" });
  fs.chmodSync(webSessionsPath(tmp), 0o000);
}

const onDisk = () =>
  Object.keys(
    JSON.parse(fs.readFileSync(webSessionsPath(tmp), "utf-8")).sessions,
  ).length;

// A root test run reads a 000 file anyway; the case can't be made there.
const canDeny = typeof process.getuid !== "function" || process.getuid() !== 0;
const itDeny = canDeny ? it : it.skip;

describe("issue 1299: a failed read never costs a session", () => {
  itDeny(
    "(1) a failed read isn't cached: the sessions are back once it reads",
    () => {
      const { s } = store();
      const a = s.create({ host: "a" });
      const b = s.create({ host: "b" });
      changedThenUnreadable();
      expect(s.lookup(a.id)).toBeNull();
      fs.chmodSync(webSessionsPath(tmp), 0o600);
      // Same inode, size and modified time as when the read failed.
      expect(s.lookup(a.id)).not.toBeNull();
      expect(s.lookup(b.id)).not.toBeNull();
    },
  );

  itDeny(
    "(2) a sign-in after a failed read is refused, and keeps every session",
    () => {
      const { s } = store();
      const a = s.create({ host: "a" });
      s.create({ host: "b" });
      changedThenUnreadable();
      expect(s.lookup(a.id)).toBeNull();
      expect(() => s.create({ host: "c" })).toThrow(SessionStoreUnreadable);
      expect(() => s.consumeCode("nonce-1", T0 + 60_000)).toThrow(
        SessionStoreUnreadable,
      );
      expect(() => s.endAll()).toThrow(SessionStoreUnreadable);
      fs.chmodSync(webSessionsPath(tmp), 0o600);
      expect(onDisk()).toBe(3);
      expect(s.lookup(a.id)).not.toBeNull();
      // Readable again: sign-in works.
      s.create({ host: "c" });
      expect(onDisk()).toBe(4);
    },
  );

  itDeny("(3) the refusal is reported by code, never a secret", () => {
    const { s, problems, kinds } = store();
    const a = s.create({ host: "a" });
    changedThenUnreadable();
    expect(() => s.create({})).toThrow(/try again/);
    expect(problems.join("\n")).toMatch(/EACCES/);
    expect(new Set(kinds)).toEqual(new Set(["unreadable"]));
    expect(problems.join("\n")).not.toContain(a.session.csrf);
    expect(problems.join("\n")).not.toContain(a.session.key);
  });

  it("(4) a file that isn't valid is moved aside, reported, and the store starts empty", () => {
    const { s, problems, kinds } = store();
    s.create({ host: "a" });
    fs.writeFileSync(webSessionsPath(tmp), "{ not json", { mode: 0o600 });
    const fresh = s.create({ host: "b" });
    expect(s.lookup(fresh.id)).not.toBeNull();
    expect(onDisk()).toBe(1);
    const aside = fs
      .readdirSync(tmp)
      .filter((f) => f.startsWith("web-sessions.json.bad-"));
    expect(aside.length).toBe(1);
    expect(fs.readFileSync(path.join(tmp, aside[0]), "utf-8")).toBe(
      "{ not json",
    );
    expect(problems.join("\n")).toMatch(/not valid.*moved aside/);
    expect(kinds).toEqual(["moved-aside"]);
  });

  it("(4) JSON that isn't an object is not valid either", () => {
    const { s, problems } = store();
    fs.writeFileSync(webSessionsPath(tmp), "null\n", { mode: 0o600 });
    s.create({});
    expect(onDisk()).toBe(1);
    expect(problems.join("\n")).toMatch(/moved aside/);
  });

  it.each([
    ['{"v":2,"sessions":{},"usedCodes":{}}', "a newer version"],
    ['{"v":1,"sessions":null,"usedCodes":{}}', "sessions null"],
    ['{"v":1,"sessions":[],"usedCodes":{}}', "sessions a list"],
    ['{"v":1,"sessions":{},"usedCodes":[]}', "usedCodes a list"],
  ])(
    "(5) a valid object of the wrong shape is moved aside: %s (%s)",
    (body) => {
      const { s, kinds } = store();
      fs.writeFileSync(webSessionsPath(tmp), body, { mode: 0o600 });
      s.create({});
      const aside = fs
        .readdirSync(tmp)
        .filter((f) => f.startsWith("web-sessions.json.bad-"));
      expect(aside.length).toBe(1);
      expect(fs.readFileSync(path.join(tmp, aside[0]), "utf-8")).toBe(body);
      expect(kinds).toEqual(["moved-aside"]);
    },
  );

  itDeny(
    "(6) a stat that fails (not a missing file) refuses writes too",
    () => {
      const { s, kinds } = store();
      s.create({ host: "a" });
      store().s.create({ host: "other" });
      fs.chmodSync(tmp, 0o000);
      try {
        expect(() => s.create({})).toThrow(SessionStoreUnreadable);
        expect(kinds).toContain("unreadable");
      } finally {
        fs.chmodSync(tmp, 0o700);
      }
      expect(onDisk()).toBe(2);
    },
  );

  it("no file yet is no problem: the first sign-in makes it", () => {
    const { s, problems } = store();
    s.create({});
    expect(onDisk()).toBe(1);
    expect(problems).toEqual([]);
  });
});

describe("issue 1299: the server answers a refused sign-in plainly", () => {
  it("503 with the try-again message and Retry-After, never a stack", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../src/ui/server/index.ts"),
      "utf-8",
    );
    const at = src.indexOf("if (err instanceof SessionStoreUnreadable) {");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("return;\n    }\n", at + 1200));
    expect(block).toMatch(/Retry-After/);
    expect(block).toMatch(/503/);
    expect(block).not.toMatch(/stack/);
    expect(src).toMatch(/onProblem: \(msg, kind\) =>/);
  });
});

describe("issue 1299: a damaged file moved aside is in the activity trail", () => {
  it("the server records it, so a person knows why they were signed out", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../src/ui/server/index.ts"),
      "utf-8",
    );
    const at = src.indexOf("onProblem: (msg, kind) =>");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 600);
    expect(block).toMatch(/kind === "moved-aside"/);
    expect(block).toMatch(/recordAction\(/);
    expect(block).toMatch(/verb: "sessions-reset"/);
  });
});
