/**
 * Issue 726: every hub/* state file and each project's Hub link belong to
 * one Hub (its origin and company). A change archives them under
 * hub/previous/<stamp>/ and starts fresh: no project keeps an id from the
 * old Hub (clause 1), and the old cursor, ids and held comments never reach
 * the new one (clause 2). A web app's relayed message is Den's own and
 * stays. A temp state dir; invented names only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  bindHub,
  decideHubBinding,
  dropUnrevoked,
  hubOrigin,
  listPreviousHubs,
  readHubBinding,
  readUnrevoked,
  recordUnrevoked,
  unrevokedToken,
  HUB_STATE_FILES,
} from "../../../src/shared/hub/hub-binding.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";

const OLD = "https://hub-one.example.test";
const NEW = "https://hub-two.example.test";
const OLD_ID = "proj_oldhubaaa";

let dir: string;
let ws: WorkspacesFile;
const writes: string[] = [];

const deps = () => ({
  stateDir: dir,
  now: () => new Date("2026-11-20T10:00:00.000Z"),
  readWorkspaces: () => structuredClone(ws),
  writeWorkspaces: (f: WorkspacesFile, by: string) => {
    writes.push(by);
    ws = structuredClone(f);
  },
});

const hubFile = (f: string) => path.join(dir, "hub", f);
const put = (f: string, v: unknown) => {
  fs.mkdirSync(path.join(dir, "hub"), { recursive: true });
  fs.writeFileSync(hubFile(f), JSON.stringify(v));
};
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-binding-"));
  writes.length = 0;
  ws = {
    workspaces: {
      web: {
        name: "web",
        hub_project: { id: OLD_ID, slug: "web-old", name: "Web (old Hub)" },
        hub_rename: { to: "x", held: "h1", askedAt: "2026-11-01T00:00:00Z" },
      },
      api: {
        name: "api",
        hub_project: {
          id: "proj_oldhubbbb",
          slug: "api-old",
          name: "API (old Hub)",
        },
      },
      docs: { name: "docs" },
    },
  } as unknown as WorkspacesFile;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 726: which Hub the state belongs to", () => {
  it("an origin is scheme, host and port; a bad address is none", () => {
    expect(hubOrigin(`${OLD}/`)).toBe(OLD);
    expect(hubOrigin("https://HUB-one.example.test:443/x")).toBe(OLD);
    expect(hubOrigin("not a url")).toBe("");
  });

  it("first seen: bind without archiving; same Hub: nothing; another origin or company: a change", () => {
    expect(decideHubBinding(null, { url: null })).toBe("same");
    expect(decideHubBinding(null, { url: OLD })).toBe("bind");
    const b = { url: OLD, origin: OLD, at: "t" };
    expect(decideHubBinding(b, { url: `${OLD}/` })).toBe("same");
    // A cleared address keeps the state: the same Hub again loses nothing.
    expect(decideHubBinding(b, { url: null })).toBe("same");
    expect(decideHubBinding(b, { url: NEW })).toBe("change");
    // The company is learned at Connect: recorded, then compared.
    expect(decideHubBinding(b, { url: OLD, company: "one" })).toBe("bind");
    const c = { ...b, company: "one" };
    expect(decideHubBinding(c, { url: OLD, company: "one" })).toBe("same");
    expect(decideHubBinding(c, { url: OLD })).toBe("same");
    expect(decideHubBinding(c, { url: OLD, company: "two" })).toBe("change");
  });

  it("an upgrade adopts the state it finds for the Hub it has: nothing archived", () => {
    put("deliveries-seen.json", { ids: ["d1"], last: "d1", held: null });
    const r = bindHub(deps(), { url: OLD });
    expect(r.kind).toBe("bind");
    expect(readHubBinding(dir)).toMatchObject({ url: OLD, origin: OLD });
    expect(fs.existsSync(hubFile("deliveries-seen.json"))).toBe(true);
    expect(ws.workspaces.web.hub_project).toBeTruthy();
    expect(listPreviousHubs(dir)).toEqual([]);
  });
});

describe("issue 726 clause 1: no project keeps a link to the old Hub", () => {
  it("a change unlinks every project, keeps the links in the archive, and names who had one", () => {
    bindHub(deps(), { url: OLD, company: "one" });
    const r = bindHub(deps(), { url: NEW });
    expect(r.kind).toBe("change");
    for (const cfg of Object.values(ws.workspaces)) {
      expect(cfg.hub_project).toBeUndefined();
      expect((cfg as Record<string, unknown>).hub_rename).toBeUndefined();
    }
    // The name shown stays what the person saw (like an unlink).
    expect(ws.workspaces.web.name).toBe("Web (old Hub)");
    expect(r.archived?.projects.sort()).toEqual(["api", "web"]);
    const prev = listPreviousHubs(dir);
    expect(prev).toHaveLength(1);
    expect(prev[0].from).toMatchObject({ origin: OLD, company: "one" });
    expect(prev[0].to).toMatchObject({ url: NEW });
    expect(JSON.stringify(read(path.join(prev[0].dir, "from.json")))).toContain(
      OLD_ID,
    );
    expect(readHubBinding(dir)).toMatchObject({ origin: NEW });
    expect(writes).toHaveLength(1);
  });

  it("the same Hub and company again changes nothing", () => {
    bindHub(deps(), { url: OLD, company: "one" });
    expect(bindHub(deps(), { url: OLD, company: "one" }).kind).toBe("same");
    expect(ws.workspaces.web.hub_project).toBeTruthy();
    expect(writes).toHaveLength(0);
  });

  it("another company on the same Hub is a change too", () => {
    bindHub(deps(), { url: OLD, company: "one" });
    expect(bindHub(deps(), { url: OLD, company: "two" }).kind).toBe("change");
    expect(ws.workspaces.web.hub_project).toBeUndefined();
  });
});

describe("issue 726 clause 2: the old Hub's cursor, ids and held comments stay behind", () => {
  it("every hub/* state file is archived; the relayed web-app message stays", () => {
    const embed = {
      id: "inbox:embed:m1",
      agent: "a1",
      text: "from the app",
    };
    put("deliveries-seen.json", {
      ids: ["old-d1", "old-d2"],
      last: "old-cursor-9",
      held: {
        queue: { a1: [{ id: "old-d3", agent: "a1" }, embed] },
        active: { a2: { ids: ["old-d4"], typedAt: 1 } },
      },
    });
    put("inbox-watch.json", { since: "2026-11-19T00:00:00Z" });
    put("tools-seen.json", { a1: "hash" });
    put("links-seen.json", { web: { id: OLD_ID, slug: "web-old", at: "t" } });
    put("deliveries-health.json", { lastDeliveryAt: 5 });
    bindHub(deps(), { url: OLD });
    bindHub(deps(), { url: NEW });

    const seen = read(hubFile("deliveries-seen.json"));
    expect(seen.ids).toEqual([]);
    expect(seen.last).toBeNull();
    expect(seen.held).toEqual({ queue: { a1: [embed] }, active: {} });
    for (const f of HUB_STATE_FILES.filter((f) => f !== "deliveries-seen.json"))
      expect(fs.existsSync(hubFile(f))).toBe(false);
    const prev = listPreviousHubs(dir)[0];
    for (const f of HUB_STATE_FILES)
      expect(fs.existsSync(path.join(prev.dir, f))).toBe(true);
    expect(read(path.join(prev.dir, "deliveries-seen.json")).last).toBe(
      "old-cursor-9",
    );
  });

  it("nothing but Den's own relays: the seen file is gone, not rewritten", () => {
    put("deliveries-seen.json", { ids: ["x"], last: "x", held: null });
    bindHub(deps(), { url: OLD });
    bindHub(deps(), { url: NEW });
    expect(fs.existsSync(hubFile("deliveries-seen.json"))).toBe(false);
  });

  it("two changes the same second each get their own folder", () => {
    bindHub(deps(), { url: OLD });
    bindHub(deps(), { url: NEW });
    bindHub(deps(), { url: OLD });
    const p = listPreviousHubs(dir);
    expect(p).toHaveLength(2);
    expect(new Set(p.map((x) => x.dir)).size).toBe(2);
  });
});

describe("issue 726 clause 3: a token that couldn't be revoked is kept on record", () => {
  it("recorded with where and why, its token readable only for a retry, then dropped", () => {
    recordUnrevoked(
      dir,
      { url: OLD, why: "Hub didn't answer", token: "hubi_TESTONLY_x" },
      new Date("2026-11-20T10:00:00Z"),
    );
    const [u] = readUnrevoked(dir);
    expect(u).toMatchObject({ url: OLD, why: "Hub didn't answer" });
    expect(JSON.stringify(readUnrevoked(dir))).not.toContain("TESTONLY");
    expect(unrevokedToken(dir, u.id)).toBe("hubi_TESTONLY_x");
    const f = fs
      .readdirSync(path.join(dir, "hub", "unrevoked"))
      .map((n) => path.join(dir, "hub", "unrevoked", n));
    for (const x of f) expect(fs.statSync(x).mode & 0o077).toBe(0);
    dropUnrevoked(dir, u.id);
    expect(readUnrevoked(dir)).toEqual([]);
    expect(unrevokedToken(dir, u.id)).toBeNull();
  });
});
