/**
 * Issue 869: web_url_set, the server agent's held write for this install's
 * address. An Allowed write sets a confirmed address through the same save
 * as Settings; a denied or unanswered (expired) one changes nothing; an
 * address that doesn't answer as this Den is never written, at the ask or
 * at the Allow. A project's agent can't propose it.
 *
 * The queue and the action, in process; the config in memory; the
 * address's answer stubbed (the probe answers 204 only when it reaches
 * this Den).
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createApprovalQueue } from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import { webUrlSetAction } from "../../../src/ui/server/web-url-held.js";
import {
  readWebUrl,
  setWebUrl,
  type WebUrlChange,
} from "../../../src/shared/web/web-url.js";
import { setConfigAuditSink } from "../../../src/shared/config-audit.js";
import { HELD_WRITE_RISK } from "../../../src/shared/approval-policy.js";
import { mintActorToken } from "../../../src/shared/actor-token.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-869-held-"));
// The asking agent still runs (its token is live).
mintActorToken(stateDir, {
  agentId: "server",
  workspace: "den-server",
  sessionName: "den-server:server",
});
const NEW = "https://den.example.test";
const OLD = "https://old.example.test";

let cfg: Record<string, unknown> = {};
let answering = true;
let saves: WebUrlChange[] = [];
/** Hosts the fake resolver places on this machine or Den already serves. */
let known = new Set<string>(["den.example.test", "old.example.test"]);
let audits: string[] = [];
const read = () => cfg as never;
const merge = (p: Record<string, unknown>) => {
  cfg = { ...cfg, ...p };
  return cfg;
};

function build(o: { now?: () => number; ttlMs?: number } = {}) {
  const action = webUrlSetAction({
    knownHost: async (host) => known.has(host),
    read: () => readWebUrl(read),
    set: (url, how) => {
      saves.push(how);
      return setWebUrl(url, merge as never, read, how);
    },
    ping: async () => (answering ? { status: 204 } : { error: "timeout" }),
    checkMs: () => 50,
  });
  const actions = heldActions({ webUrlSet: action } as never);
  return {
    actions,
    queue: createApprovalQueue(actions, () => stateDir, o),
  };
}

const SERVER = { agent: "server", project: "den-server" };

async function ask(
  b: ReturnType<typeof build>,
  url = NEW,
  who: { agent?: string; project?: string } = SERVER,
) {
  const c = await b.actions.web_url_set.check({ url }, who);
  if (!c.ok) return { checked: c, approval: null };
  const approval = b.queue.request({
    actor: "agent:server",
    agent: "server",
    action: "web_url_set",
    args: c.args,
    summary: c.summary,
    params: c.params,
    details: c.details,
  });
  return { checked: c, approval };
}

beforeEach(() => {
  audits = [];
  setConfigAuditSink((e: unknown) => {
    audits.push(JSON.stringify(e));
  });
  known = new Set(["den.example.test", "old.example.test"]);
  cfg = {
    web: { url: OLD, url_confirmed: false, url_from: "the edge's route" },
  };
  answering = true;
  saves = [];
});

describe("web_url_set", () => {
  it("is held for the person's own Allow, with what it does", async () => {
    const { checked } = await ask(build());
    expect(checked).toMatchObject({
      ok: true,
      personOnly: true,
      args: { url: NEW },
    });
    if (!checked.ok) throw new Error("refused");
    expect(checked.details.join(" ")).toContain(OLD);
    expect(HELD_WRITE_RISK.web_url_set).toBeDefined();
  });

  it("Allowed: the address is set, confirmed, through Settings' save", async () => {
    const b = build();
    const { approval } = await ask(b);
    const r = await b.queue.decide(approval!.id, "allow", "person:me");
    expect(r.ok).toBe(true);
    expect(readWebUrl(read)).toEqual({ url: NEW, confirmed: true });
    expect(saves).toEqual([
      { path: "held write web_url_set", who: "person:me" },
    ]);
  });

  it("Allowed: the audit has both the old address and the new", async () => {
    const b = build();
    const { approval } = await ask(b);
    await b.queue.decide(approval!.id, "allow", "person:me");
    expect(audits.join("\n")).toContain(`${OLD} → ${NEW}`);
  });

  it("a host that isn't this machine or one Den serves gets its warning, first", async () => {
    const away = "https://tunnel.elsewhere.test";
    const { checked } = await ask(build(), away);
    if (!checked.ok) throw new Error("refused");
    expect(checked.details[0]).toBe(
      "New host: tunnel.elsewhere.test isn't this machine or an address Den serves. Sign-in and every link will go through it.",
    );
    expect(checked.detailKeys?.[0]).toEqual({
      key: "ap.det.web_url_set.newHost",
      vars: { host: "tunnel.elsewhere.test" },
    });
  });

  it("a host this machine has, or one Den serves (the current address, the mesh name), gets no warning", async () => {
    for (const url of [NEW, OLD]) {
      const { checked } = await ask(build(), url);
      if (!checked.ok) throw new Error("refused");
      expect(checked.details.join(" ")).not.toContain("New host:");
    }
  });

  it("the warning never refuses: a real tunnel for remote access is allowed", async () => {
    const { checked } = await ask(build(), "https://tunnel.elsewhere.test");
    expect(checked.ok).toBe(true);
  });

  it("Denied: nothing changes", async () => {
    const b = build();
    const { approval } = await ask(b);
    await b.queue.decide(approval!.id, "deny", "person:me");
    expect(readWebUrl(read)).toMatchObject({ url: OLD, confirmed: false });
    expect(saves).toEqual([]);
  });

  it("Unanswered (expired): nothing changes", async () => {
    let t = 1_000;
    const b = build({ now: () => t, ttlMs: 1_000 });
    const { approval } = await ask(b);
    t += 5_000;
    const r = await b.queue.decide(approval!.id, "allow", "person:me");
    expect(r.ok).toBe(false);
    expect(readWebUrl(read)).toMatchObject({ url: OLD, confirmed: false });
    expect(saves).toEqual([]);
  });

  it("an address that doesn't answer is refused at the ask", async () => {
    answering = false;
    const { checked, approval } = await ask(build());
    expect(checked.ok).toBe(false);
    expect(approval).toBeNull();
    expect(saves).toEqual([]);
  });

  it("one that stops answering before the Allow is never written", async () => {
    const b = build();
    const { approval } = await ask(b);
    answering = false;
    await b.queue.decide(approval!.id, "allow", "person:me");
    expect(readWebUrl(read)).toMatchObject({ url: OLD, confirmed: false });
    expect(saves).toEqual([]);
  });

  it("a loopback name is refused", async () => {
    const { checked } = await ask(build(), "https://den.localhost");
    expect(checked.ok).toBe(false);
  });

  it("a project's agent can't propose it", async () => {
    const { checked } = await ask(build(), NEW, {
      agent: "a1",
      project: "web",
    });
    expect(checked.ok).toBe(false);
  });
});
