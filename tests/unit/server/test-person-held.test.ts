/**
 * Issue 816: test_person_setup, the held write on your own Den that sets up
 * a test install's test person on this computer. Only your own Allow runs
 * it. At the Allow, in one step: the entry is found again, its pid is
 * alive, its port answers as that install (the identity probe), and it says
 * it still waits; then a one-use grant and that install's person bearer
 * are sent once to 127.0.0.1:<port>, with a challenge it must answer as
 * itself. The grant and the bearer are never returned, stored, logged or
 * put in the review.
 *
 * The test install's side is stubbed: it takes the grant with the real
 * takeSetupGrant, under its real secret.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { testPersonSetupAction } from "../../../src/ui/server/test-person-held.js";
import {
  installIdOf,
  takeSetupGrant,
  type Announced,
} from "../../../src/shared/test-install-grant.js";
import { personToken } from "../../../src/shared/web-secret.js";
import {
  identityAnswer,
  identityKey,
} from "../../../src/shared/den-identity.js";

const HOME = fs.realpathSync(os.tmpdir());
let stateDir = "";
let entry: Announced;
const secret = Buffer.alloc(32, 5);
let alive = true;
let probeOk = true;
let waiting = true;
let answerRight = true;
let posts: { port: number; body: string; bearer: string }[] = [];
let audits: string[] = [];
let taken: ReturnType<typeof takeSetupGrant>[] = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(HOME, "den-816-held-"));
  entry = {
    id: installIdOf(stateDir),
    stateDir,
    port: 45123,
    pid: 4242,
    startedAt: "",
  };
  alive = probeOk = waiting = answerRight = true;
  posts = [];
  audits = [];
  taken = [];
});

function build() {
  return testPersonSetupAction({
    ownId: "aaaaaaaaaaaaaaaa",
    home: HOME,
    list: () => [entry],
    alive: () => alive,
    probe: async () => probeOk,
    waiting: async () => waiting,
    readSecret: () => secret,
    ttlSeconds: () => 30,
    post: async (port, bearer, body) => {
      posts.push({ port, body, bearer });
      const b = JSON.parse(body) as { grant: string; challenge: string };
      const t = takeSetupGrant(b.grant, { secret, stateDir });
      taken.push(t);
      return {
        status: t.ok ? 200 : 403,
        json: {
          ok: t.ok,
          answer: answerRight
            ? identityAnswer(identityKey(secret), b.challenge)
            : "wrong",
        },
      };
    },
    audit: (row) => audits.push(JSON.stringify(row)),
  });
}

describe("test_person_setup: the ask", () => {
  it("is the person's own Allow only, naming the install by id and ~/ path", async () => {
    const c = await build().check({ id: entry.id });
    expect(c).toMatchObject({ ok: true, personOnly: true });
    if (!c.ok) throw new Error("refused");
    const words = [c.summary, ...c.details].join(" ");
    expect(words).toContain(entry.id);
    expect(words).toContain("~/" + path.relative(HOME, stateDir));
  });

  it("refuses an install that isn't announced", async () => {
    expect((await build().check({ id: "0123456789abcdef" })).ok).toBe(false);
  });

  it("refuses one whose port doesn't answer as that install", async () => {
    probeOk = false;
    expect((await build().check({ id: entry.id })).ok).toBe(false);
  });

  it("refuses one that no longer waits for setup", async () => {
    waiting = false;
    expect((await build().check({ id: entry.id })).ok).toBe(false);
  });
});

describe("test_person_setup: the Allow", () => {
  it("sends one grant the test install takes, with its own bearer, to 127.0.0.1:<port>", async () => {
    const r = (await build().run({ id: entry.id })) as { ok: boolean };
    expect(r.ok).toBe(true);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.port).toBe(45123);
    expect(posts[0]!.bearer).toBe(personToken(secret));
    expect(taken).toEqual([{ ok: true, from: "aaaaaaaaaaaaaaaa" }]);
  });

  it("a pid gone by the Allow: nothing is sent", async () => {
    alive = false;
    const r = (await build().run({ id: entry.id })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(posts).toEqual([]);
  });

  it("a port that stops answering as that install by the Allow: nothing is sent", async () => {
    probeOk = false;
    const r = (await build().run({ id: entry.id })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(posts).toEqual([]);
  });

  it("a wrong answer to the challenge is a failure, recorded", async () => {
    answerRight = false;
    const r = (await build().run({ id: entry.id })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(audits.join("\n")).toMatch(/didn't answer as that install/);
  });

  it("the grant and the bearer are in no answer, review line or activity row", async () => {
    const a = build();
    const c = await a.check({ id: entry.id });
    const r = await a.run({ id: entry.id });
    const grant = (JSON.parse(posts[0]!.body) as { grant: string }).grant;
    const seen = JSON.stringify([c, r, audits]);
    expect(seen).not.toContain(grant);
    expect(seen).not.toContain(personToken(secret));
    expect(seen).not.toContain(path.join(stateDir, "web.secret"));
  });

  it("the activity row names the install by id and ~/ path", async () => {
    await build().run({ id: entry.id });
    expect(audits.join("\n")).toContain(entry.id);
    expect(audits.join("\n")).toContain("~/");
  });
});
