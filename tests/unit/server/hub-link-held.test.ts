/**
 * Issue 647: the held write hub_link links a project to an existing Hub
 * project, as `hub link` and Settings › Project setup do. The agent asks;
 * the person allows; then Den links it. The link is by the Hub project's
 * id (or its slug), never a name match, and a Hub project the connected
 * Hub doesn't list is refused before anyone is asked. A stub Hub on
 * localhost plays Hub, answered through Den's own client. Invented names
 * only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { hubProjectChoices } from "../../../src/shared/hub.js";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";
import {
  HELD_WRITE_RISK,
  isCriticalWrite,
  policyFor,
} from "../../../src/shared/approval-policy.js";
import { createApprovalQueue } from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  checkHubLinkHeld,
  runHubLinkHeld,
  type HubLinkHeldDeps,
} from "../../../src/ui/server/hub-link-held.js";

const TOKEN = "hubi_TESTONLYlink647";
const servers: http.Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** This company's Hub projects, as the connected Hub lists them. */
const HUB_PROJECTS = [
  { id: "proj_n1", slug: "north-star", name: "North Star" },
  { id: "proj_c2", slug: "comet", name: "Comet" },
  // A name that is another project's slug: never matched by name.
  { id: "proj_x3", slug: "x-ray", name: "comet-tail" },
];

async function rig(
  o: { offline?: boolean; links?: Record<string, HubProjectLink> } = {},
) {
  const s = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        ok ? { suggestions: [], projects: HUB_PROJECTS } : { error: "no" },
      ),
    );
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const links = new Map(Object.entries(o.links ?? {}));
  const writes: { ws: string; link: HubProjectLink | null; by?: string }[] =
    [];
  let changed = 0;
  const d: HubLinkHeldDeps = {
    exists: (ws) => ["north", "south"].includes(ws),
    read: (ws) => links.get(ws) ?? null,
    choices: async (ws) =>
      o.offline
        ? null
        : hubProjectChoices(base, TOKEN, { workspace: ws, repos: [] }),
    write: (ws, link, by) => {
      writes.push({ ws, link, by });
      if (link) links.set(ws, link);
      else links.delete(ws);
    },
    changed: () => void changed++,
  };
  return { d, links, writes, changed: () => changed };
}

/** The held-write queue as the server runs it, with hub_link's deps. */
function queueFor(d: HubLinkHeldDeps) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hub-link-"));
  const actions = heldActions({
    hubLink: {
      check: (a, who) => checkHubLinkHeld(d, a, who),
      run: (a, asked) => runHubLinkHeld(d, a, asked),
    },
  } as Parameters<typeof heldActions>[0]);
  return { actions, queue: createApprovalQueue(actions, () => stateDir) };
}

async function ask(d: HubLinkHeldDeps, args: Record<string, unknown>) {
  const { actions, queue } = queueFor(d);
  const c = await actions.hub_link.check(args, {
    agent: "agt_den1",
    project: "den-server",
  });
  if (!c.ok) throw new Error(c.error);
  const a = queue.request({
    actor: "agent:agt_den1",
    agent: "agt_den1",
    action: "hub_link",
    args: c.args,
    summary: c.summary,
    params: c.params,
    details: c.details,
  });
  return { queue, a, c };
}

describe("issue 647 clause 1: hub_link waits as a held write; Allow links it", () => {
  it("nothing is linked while it waits; after Allow the project is linked by the Hub project's id", async () => {
    const r = await rig();
    const { queue, a, c } = await ask(r.d, {
      project: "north",
      hub: "proj_n1",
    });
    expect(a.state).toBe("pending");
    expect(r.writes).toEqual([]);
    expect(c.summary).toBe(
      "link project north to the Hub project North Star (north-star)",
    );
    const done = await queue.decide(a.id, "allow", "person:owner");
    expect(done.ok).toBe(true);
    expect(r.links.get("north")).toEqual({
      id: "proj_n1",
      slug: "north-star",
      name: "North Star",
    });
    expect(r.writes[0].by).toMatch(/hub_link.*agt_den1/);
    expect(r.changed()).toBe(1);
    expect(queue.get(a.id)?.result).toMatchObject({
      ok: true,
      project: "north",
      hub: { id: "proj_n1" },
    });
  });

  it("relinks a linked project; the Allow shows what it is now and what it will be, in en, es and ja", async () => {
    const r = await rig({
      links: { south: { id: "proj_old", slug: "old", name: "Old" } },
    });
    const c = await checkHubLinkHeld(
      r.d,
      { project: "south", hub: "comet" },
      {},
    );
    expect(c).toMatchObject({
      ok: true,
      args: { project: "south", hub: "proj_c2" },
    });
    if (!c.ok) return;
    expect(c.details.join("\n")).toMatch(/Now: Old \(old\)/);
    expect(c.details.join("\n")).toMatch(/Then: Comet \(comet\)/);
    expect(c.detailKeys).toHaveLength(c.details.length);
    const pub = path.resolve(__dirname, "../../../src/ui/server/public");
    const cats = ["shell.js", "i18n/es.js", "i18n/ja.js"].map((f) =>
      fs.readFileSync(path.join(pub, f), "utf-8"),
    );
    for (const k of [
      ...c.detailKeys!.map((x) => x!.key),
      "ap.do.hub_link",
      "ap.hl.nowNone",
    ])
      for (const cat of cats) expect(cat).toContain(`"${k}":`);
  });

  it("the policy places it: routine, but it asks unless the person lowers it", () => {
    expect(HELD_WRITE_RISK.hub_link?.risk).toBe("routine");
    expect(isCriticalWrite("hub_link", false)).toBe(false);
    expect(policyFor("hub_link", {}).kind).toBe("ask");
  });
});

describe("issue 647 clause 2: Deny leaves the link as it was", () => {
  it("a denied hub_link writes nothing", async () => {
    const was = { id: "proj_old", slug: "old", name: "Old" };
    const r = await rig({ links: { south: was } });
    const { queue, a } = await ask(r.d, { project: "south", hub: "proj_c2" });
    const done = await queue.decide(a.id, "deny", "person:owner");
    expect(done.ok).toBe(true);
    expect(queue.get(a.id)?.state).toBe("denied");
    expect(r.writes).toEqual([]);
    expect(r.links.get("south")).toEqual(was);
    expect(r.changed()).toBe(0);
  });
});

describe("issue 647 clause 3: a Hub project the connected Hub doesn't list is refused", () => {
  it("an id from another Hub is refused with its reason; nothing is asked", async () => {
    const r = await rig();
    const c = await checkHubLinkHeld(
      r.d,
      { project: "north", hub: "proj_elsewhere9" },
      {},
    );
    expect(c).toMatchObject({
      ok: false,
      error: expect.stringMatching(
        /the connected Hub has no Hub project "proj_elsewhere9".*another Hub/,
      ),
    });
  });

  it("never a name match: a Hub project's name is not its id or slug", async () => {
    const r = await rig();
    for (const hub of ["North Star", "comet-tail"]) {
      const c = await checkHubLinkHeld(r.d, { project: "north", hub }, {});
      expect(c.ok).toBe(false);
    }
  });

  it("refuses: Hub not connected, no project, Den's own place, another project for a project's agent, already linked to it", async () => {
    const off = await rig({ offline: true });
    expect(
      await checkHubLinkHeld(off.d, { project: "north", hub: "proj_n1" }, {}),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/connected/) });
    const r = await rig({
      links: {
        south: { id: "proj_c2", slug: "comet", name: "Comet" },
      },
    });
    const no = (a: Record<string, unknown>, who = {}) =>
      checkHubLinkHeld(r.d, a, who);
    expect(await no({ project: "east", hub: "proj_n1" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no project "east"/),
    });
    expect(await no({ project: "den-server", hub: "proj_n1" })).toMatchObject(
      { ok: false },
    );
    expect(await no({ project: "north" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/hub:/),
    });
    expect(
      await no(
        { project: "north", hub: "proj_n1" },
        { agent: "planner", project: "south" },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/south/) });
    expect(await no({ project: "south", hub: "proj_c2" })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already linked/),
    });
  });

  it("an id Hub stops listing between the ask and the Allow is refused at the Allow; the link stays", async () => {
    const r = await rig();
    const { queue, a } = await ask(r.d, { project: "north", hub: "proj_n1" });
    r.d.choices = async () => ({ suggestions: [], projects: [] });
    await queue.decide(a.id, "allow", "person:owner");
    expect(queue.get(a.id)?.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/no Hub project "proj_n1"/),
    });
    expect(r.writes).toEqual([]);
  });
});
