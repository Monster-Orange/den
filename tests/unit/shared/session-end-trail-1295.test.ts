/**
 * Issue 1295: every way a browser session ends records why in the activity
 * trail. On a test install two of the gate runner's own test-person
 * sessions reached their 60 minutes and ended, silently, when the runner
 * next showed their cookies; nothing in any log said so.
 *
 *  1. The store says what it ended and why, on every end path (its own
 *     end, end-where, end-by-prefix and end-all); nothing when nothing
 *     ended; a failing listener never stops the end.
 *  2. The trail row names the session by the id `web sessions` shows (8
 *     hex) and says why in words; never the key, cookie or CSRF value.
 *  3. Why a test-person session no longer stands: its time ran out, the
 *     test person was set up again, or test sign-in isn't allowed.
 *  4. The server hands every end to the activity trail.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  fixtureSessionEndWhy,
  sessionEndRow,
  WebSessionStore,
  type SessionEndWhy,
  type SessionView,
} from "../../../src/shared/web-session.js";

const T0 = Date.UTC(2026, 10, 23, 5, 7, 54);
let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1295-")));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function store(onEnd?: (ended: SessionView[], why: SessionEndWhy) => void) {
  const secret = randomBytes(32);
  let now = T0;
  const s = new WebSessionStore({
    stateDir: () => tmp,
    secret: () => secret,
    now: () => now++,
    onEnd,
  });
  return s;
}

describe("issue 1295 (1): the store says what it ended and why", () => {
  it("every end path reports the sessions and the reason", () => {
    const seen: [string[], SessionEndWhy][] = [];
    const s = store((ended, why) => seen.push([ended.map((e) => e.key), why]));
    const a = s.create({ host: "a" }).session;
    const b = s.create({ host: "b" }).session;
    const c = s.create({ host: "c" }).session;
    const d = s.create({ host: "d" }).session;
    s.end(a.key, "signed-out");
    s.endWhere((x) => x.host === "b", "address-proven");
    s.endByPrefix(c.key.slice(0, 8), "revoked");
    s.endAll("signed-out-everywhere");
    expect(seen).toEqual([
      [[a.key], "signed-out"],
      [[b.key], "address-proven"],
      [[c.key], "revoked"],
      [[d.key], "signed-out-everywhere"],
    ]);
  });

  it("nothing ended: nothing reported", () => {
    const seen: unknown[] = [];
    const s = store((...x) => seen.push(x));
    expect(s.end("no-such-key", "signed-out")).toBe(false);
    expect(s.endWhere(() => false, "address-proven")).toEqual([]);
    expect(s.endAll("signed-out-everywhere")).toBe(0);
    expect(seen).toEqual([]);
  });

  it("a listener that throws never stops the end", () => {
    const s = store(() => {
      throw new Error("trail down");
    });
    const a = s.create({});
    expect(s.end(a.session.key, "signed-out")).toBe(true);
    expect(s.lookup(a.id)).toBeNull();
  });
});

describe("issue 1295 (2): the trail row", () => {
  const view = (o: Partial<SessionView>): SessionView =>
    ({
      key: "0123abcd" + "ef".repeat(28),
      createdAt: T0,
      lastSeenAt: T0,
      userAgent: "node",
      csrf: "CSRF-SECRET-VALUE",
      host: "127.0.0.1:7796",
      reach: "loopback",
      ...o,
    }) as SessionView;

  it("a test-person session that ran out: id, who and why", () => {
    const row = sessionEndRow(view({ via: "fixture" }), "fixture-expired");
    expect(row).toEqual({
      verb: "session-end",
      detail: expect.stringMatching(
        /^0123abcd \(test person\) ended: .*time limit/,
      ),
      principal: "fixture:person",
    });
  });

  it("names a person's session by login, an agent view by its agent", () => {
    expect(sessionEndRow(view({ login: "octo" }), "revoked")).toMatchObject({
      principal: "person:octo",
      detail: expect.stringMatching(/^0123abcd \(browser\) ended: /),
    });
    expect(
      sessionEndRow(
        view({ via: "agent-view", agent: "scout" }),
        "agent-view-ended",
      ),
    ).toMatchObject({ principal: "agent:scout" });
  });

  it("every reason has words, and never a secret", () => {
    const whys: SessionEndWhy[] = [
      "signed-out",
      "revoked",
      "signed-out-everywhere",
      "address-proven",
      "fixture-expired",
      "fixture-key-changed",
      "fixture-not-allowed",
      "agent-view-ended",
    ];
    for (const why of whys) {
      const row = sessionEndRow(view({}), why);
      expect(row.detail).toMatch(/ ended: \S/);
      expect(row.detail).not.toContain("CSRF-SECRET-VALUE");
      expect(row.detail).not.toContain("ef".repeat(28));
    }
  });
});

describe("issue 1295 (3): why a test-person session no longer stands", () => {
  const fp = "fp-now";
  const allowed = { testInstall: true, fingerprint: fp, minutes: 60 };

  it("the incident: made at 21:07:54, shown again at 22:08:58: its time ran out", () => {
    const s = { createdAt: T0, fixtureKey: fp };
    expect(
      fixtureSessionEndWhy(s, { ...allowed, now: T0 + 61 * 60_000 + 4_000 }),
    ).toBe("fixture-expired");
    expect(fixtureSessionEndWhy(s, { ...allowed, now: T0 + 59 * 60_000 })).toBe(
      null,
    );
  });

  it("the test person set up again (a new key)", () => {
    expect(
      fixtureSessionEndWhy(
        { createdAt: T0, fixtureKey: "fp-old" },
        { ...allowed, now: T0 },
      ),
    ).toBe("fixture-key-changed");
  });

  it("test sign-in not allowed here any more", () => {
    const s = { createdAt: T0, fixtureKey: fp };
    expect(
      fixtureSessionEndWhy(s, { ...allowed, testInstall: false, now: T0 }),
    ).toBe("fixture-not-allowed");
    expect(
      fixtureSessionEndWhy(s, { ...allowed, fingerprint: null, now: T0 }),
    ).toBe("fixture-not-allowed");
  });
});

describe("issue 1295 (4): the server hands every end to the trail", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../../src/ui/server/index.ts"),
    "utf-8",
  );

  it("its session store records each end with sessionEndRow", () => {
    const at = src.indexOf("const webSessions = new WebSessionStore({");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("\n});\n", at));
    expect(block).toMatch(/onEnd:/);
    expect(src).toMatch(/recordAction\(\s*null,\s*\{\s*verb: row\.verb/);
  });

  it("a test-person session that no longer stands ends with its reason", () => {
    expect(src).toMatch(/fixtureSessionEndWhy\(/);
    expect(src).not.toMatch(/webSessions\.end\(s\.key\);/);
  });
});
