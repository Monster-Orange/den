/**
 * Doctor names Hub tokens kept without their record. Den keeps a token an
 * earlier Hub couldn't revoke (hub/unrevoked/<id>.token) beside its record
 * (<id>.json: which Hub, when, why). A record Den can't read is kept in
 * backup (issue 786), and its token then had no Hub to retry: it dropped
 * out of every list. Doctor now names it by id (never its value), says
 * where to revoke it, and never retries it; once revoked, a person clears
 * it through a held write they Allow.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  forgetOrphanToken,
  readOrphanTokens,
  readUnrevoked,
  recordUnrevoked,
} from "../../src/shared/hub-binding.js";
import { HELD_WRITE_RISK } from "../../src/shared/approval-policy.js";
import { SERVER_SCOPE } from "../../src/shared/agents/server-agent.js";
import { previousHubLines } from "../../src/ui/cli/doctor-hub-previous.js";
import {
  heldActions,
  type HeldActionDeps,
} from "../../src/ui/server/held-actions.js";

const TOKEN = "den_hub_LIVETOKENabcdef0123456789";
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const stateDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-orphan-"));
  tmps.push(d);
  return d;
};
const unrevokedDir = (s: string) => path.join(s, "hub", "unrevoked");

/** A kept token whose record Den can't read. */
function orphaned(s: string): string {
  const rec = recordUnrevoked(s, {
    url: "https://hub.example.test",
    why: "unreachable",
    token: TOKEN,
  });
  fs.writeFileSync(path.join(unrevokedDir(s), `${rec.id}.json`), '{"id": ');
  return rec.id;
}

describe("a Hub token kept without its record", () => {
  it("an unreadable record: its token is listed by id, and no longer retried", () => {
    const s = stateDir();
    const id = orphaned(s);
    expect(readUnrevoked(s)).toEqual([]);
    expect(readOrphanTokens(s)).toEqual([
      {
        id,
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        kept: expect.stringMatching(/\.bad$/),
      },
    ]);
  });

  it("doctor points to the record's copy in backup, which may name the Hub (Reviewer C)", () => {
    const s = stateDir();
    const id = orphaned(s);
    const [t] = readOrphanTokens(s);
    expect(fs.existsSync(path.join(s, "backup", t!.kept!))).toBe(true);
    const row = previousHubLines({
      current: null,
      bound: null,
      previous: [],
      unrevoked: [],
      orphans: [t!],
    }).checks.find((c) => c.id === "hub:orphan-token")!;
    expect(row.detail).toContain(`backup/${t!.kept}`);
    expect(row.detail).toContain(id);
  });

  it("a record Den can't read or move stays, and forgetting refuses while it does (Reviewer C)", () => {
    const s = stateDir();
    const rec = recordUnrevoked(s, {
      url: "https://hub.example.test",
      why: "unreachable",
      token: TOKEN,
    });
    const json = path.join(unrevokedDir(s), `${rec.id}.json`);
    fs.rmSync(json);
    fs.mkdirSync(json);
    const [t] = readOrphanTokens(s);
    expect(t).toMatchObject({ id: rec.id, stuck: true });
    expect(forgetOrphanToken(s, rec.id)).toBe(false);
    expect(fs.existsSync(json)).toBe(true);
    expect(fs.existsSync(path.join(unrevokedDir(s), `${rec.id}.token`))).toBe(
      true,
    );
    const row = previousHubLines({
      current: null,
      bound: null,
      previous: [],
      unrevoked: [],
      orphans: [t!],
    }).checks.find((c) => c.id === "hub:orphan-token")!;
    expect(row.detail).toContain(`hub/unrevoked/${rec.id}.json`);
  });

  it("a token with its record is not an orphan; neither is a stray file", () => {
    const s = stateDir();
    recordUnrevoked(s, {
      url: "https://hub.example.test",
      why: "x",
      token: TOKEN,
    });
    fs.writeFileSync(path.join(unrevokedDir(s), "notes.token"), "x");
    expect(readUnrevoked(s)).toHaveLength(1);
    expect(readOrphanTokens(s)).toEqual([]);
  });

  it("doctor names it by id, says where to revoke it, and never shows the token", () => {
    const s = stateDir();
    const id = orphaned(s);
    const r = previousHubLines({
      current: null,
      bound: null,
      previous: [],
      unrevoked: [],
      orphans: readOrphanTokens(s),
    });
    const row = r.checks.find((c) => c.id === "hub:orphan-token")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(id);
    expect(row.detail).toMatch(/tokens page/);
    expect(row.detail).toMatch(/hub_token_forget/);
    expect(row.detail).not.toMatch(/tries|retr/);
    const all = [...r.lines, ...r.checks.map((c) => c.detail)].join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TOKEN.slice(0, 12));
  });

  it("none: doctor says so", () => {
    const r = previousHubLines({
      current: null,
      bound: null,
      previous: [],
      unrevoked: [],
      orphans: [],
    });
    expect(r.checks.find((c) => c.id === "hub:orphan-token")).toMatchObject({
      status: "ok",
    });
  });

  it("forgetting removes an orphan only: never a token Den still retries, never a bad id", () => {
    const s = stateDir();
    const id = orphaned(s);
    const kept = recordUnrevoked(s, {
      url: "https://hub.example.test",
      why: "x",
      token: TOKEN,
    });
    expect(forgetOrphanToken(s, kept.id)).toBe(false);
    expect(forgetOrphanToken(s, "../../web.secret")).toBe(false);
    expect(fs.existsSync(path.join(unrevokedDir(s), `${kept.id}.token`))).toBe(
      true,
    );
    expect(forgetOrphanToken(s, id)).toBe(true);
    expect(fs.existsSync(path.join(unrevokedDir(s), `${id}.token`))).toBe(
      false,
    );
    expect(readOrphanTokens(s)).toEqual([]);
    expect(readUnrevoked(s).map((u) => u.id)).toEqual([kept.id]);
  });
});

describe("hub_token_forget: a held write the person Allows", () => {
  const deps = (s: string): HeldActionDeps =>
    ({
      hubOrphans: {
        list: () => readOrphanTokens(s),
        forget: (id: string) => forgetOrphanToken(s, id),
      },
    }) as unknown as HeldActionDeps;

  it("always the person's Allow (it touches a secret)", () => {
    expect(HELD_WRITE_RISK.hub_token_forget).toMatchObject({
      risk: "critical",
    });
  });

  it("checks the id is a kept token without its record; the review never shows the token; on Allow it is removed", async () => {
    const s = stateDir();
    const id = orphaned(s);
    const a = heldActions(deps(s)).hub_token_forget;
    const c = await a.check({ id }, { agent: "server", project: SERVER_SCOPE });
    expect(c).toMatchObject({ ok: true, args: { id } });
    const said = JSON.stringify(c);
    expect(said).not.toContain(TOKEN);
    expect(said).toMatch(/revoked/);
    await a.run((c as { args: Record<string, unknown> }).args, {
      agent: "server",
      project: SERVER_SCOPE,
    } as never);
    expect(readOrphanTokens(s)).toEqual([]);
  });

  it("refuses a token Den still retries, an unknown id, and a Den without the store", async () => {
    const s = stateDir();
    const kept = recordUnrevoked(s, {
      url: "https://hub.example.test",
      why: "x",
      token: TOKEN,
    });
    const a = heldActions(deps(s)).hub_token_forget;
    for (const id of [kept.id, "0123456789ab", "x"])
      expect(
        await a.check({ id }, { agent: "server", project: SERVER_SCOPE }),
      ).toMatchObject({
        ok: false,
      });
    expect(
      await heldActions({} as HeldActionDeps).hub_token_forget.check(
        { id: kept.id },
        { agent: "server", project: SERVER_SCOPE },
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("hub_token_forget: only Den's own agent asks (Reviewer C)", () => {
  it("refuses a person's CLI, another agent, and Den's agent outside its own scope", async () => {
    const s = stateDir();
    const id = orphaned(s);
    const a = heldActions({
      hubOrphans: {
        list: () => readOrphanTokens(s),
        forget: (i: string) => forgetOrphanToken(s, i),
      },
    } as unknown as HeldActionDeps).hub_token_forget;
    for (const who of [
      undefined,
      { agent: "scout", project: SERVER_SCOPE },
      { agent: "server", project: "den" },
      { agent: "server" },
    ])
      expect(await a.check({ id }, who as never)).toMatchObject({ ok: false });
    expect(
      await a.check({ id }, { agent: "server", project: SERVER_SCOPE }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a token whose record is still there but can't be read", async () => {
    const s = stateDir();
    const rec = recordUnrevoked(s, {
      url: "https://hub.example.test",
      why: "unreachable",
      token: TOKEN,
    });
    const json = path.join(unrevokedDir(s), `${rec.id}.json`);
    fs.rmSync(json);
    fs.mkdirSync(json);
    const a = heldActions({
      hubOrphans: {
        list: () => readOrphanTokens(s),
        forget: (i: string) => forgetOrphanToken(s, i),
      },
    } as unknown as HeldActionDeps).hub_token_forget;
    expect(
      await a.check({ id: rec.id }, { agent: "server", project: SERVER_SCOPE }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/can't read/) });
  });
});

describe("the doctor row says where to look", () => {
  const orphan = { id: "0123456789ab", at: "2026-11-20T10:00:00.000Z" };
  const archived = (origin: string) =>
    ({
      at: "2026-11-01T00:00:00.000Z",
      dir: "/state/hub/previous/x",
      projects: [],
      from: { url: `${origin}/`, origin },
    }) as never;

  it("names the earlier Hubs this install was on, each once", () => {
    const r = previousHubLines({
      current: null,
      bound: null,
      previous: [
        archived("https://one.example.test"),
        archived("https://two.example.test"),
        archived("https://one.example.test"),
      ],
      unrevoked: [],
      orphans: [orphan],
    });
    const d = r.checks.find((c) => c.id === "hub:orphan-token")!.detail;
    expect(d).toMatch(
      /earlier Hubs this install was on: https:\/\/one\.example\.test, https:\/\/two\.example\.test/,
    );
  });

  it("none known: it doesn't guess", () => {
    const r = previousHubLines({
      current: null,
      bound: null,
      previous: [],
      unrevoked: [],
      orphans: [orphan],
    });
    expect(
      r.checks.find((c) => c.id === "hub:orphan-token")!.detail,
    ).not.toMatch(/earlier Hubs this install was on/);
  });
});
