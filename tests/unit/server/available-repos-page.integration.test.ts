import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  gitRepo,
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";
import { encodeCursor } from "../../../src/ui/server/paging.js";

const LIST = "workspaces.available-repos";
const ROUTE = "/api/workspaces/available-repos";
const LOCAL = ["north", "south", "team/east", "team/west"];
const CLONES: [string, string][] = [
  ["app", "dev"],
  ["app", "main"],
  ["app-web", "main"],
  ["app.v2", "main"],
];
const CATALOG_ONLY = ["ghost", "spirits/wisp"];

type Row = {
  name: string;
  relPath: string;
  source: string;
  currentBranch?: string;
  gh: string | null;
};
type Page = { items: Row[]; next: string | null; prev: string | null };

let tmp = "";
let srv: SlowGitServer;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-repos-page-"));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    `environments: [local]\nrepos_root: ${repos}\n`,
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    [
      "team/west:\n  gh: acme/far-meadow\n",
      "app-web:\n  gh: acme/storefront\n",
      ...CATALOG_ONLY.map((n) => `${n}:\n  gh: acme/${n.replace("/", "-")}\n`),
    ].join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    "active: default\nworkspaces:\n  default:\n    services: {}\n",
  );
  for (const n of LOCAL) {
    gitRepo(
      path.join(repos, n),
      `https://github.com/acme/${n.replace("/", "-")}.git`,
    );
    write(path.join(repos, n, ".den.yml"), `name: ${n}\nservices: {}\n`);
  }
  for (const [repo, branch] of CLONES)
    gitRepo(
      path.join(root, ".den-services", repo, branch),
      `https://github.com/acme/${repo}.git`,
    );
  srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
}, 40_000);

afterAll(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ask = async (q: string) => {
  const r = await srv.timed(`${ROUTE}?refresh=1&${q}`, srv.auth());
  return { status: r.status, body: JSON.parse(r.body) as unknown };
};
const id = (r: Row) => `${r.source}:${r.relPath}:${r.currentBranch ?? ""}`;

async function walk(limit: number, extra = ""): Promise<Row[]> {
  const out: Row[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < 50; n++) {
    const c: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const { status, body } = await ask(`limit=${limit}${extra}${c}`);
    expect(status).toBe(200);
    const page = body as Page;
    expect(page.items.length).toBeLessThanOrEqual(limit);
    out.push(...page.items);
    if (!page.next) return out;
    cursor = page.next;
  }
  throw new Error("the list never ended");
}

describe("the repo picker's list pages", () => {
  it("?all=1 is the whole list, every source in it", async () => {
    const { status, body } = await ask("all=1");
    expect(status).toBe(200);
    const all = body as Row[];
    expect(Array.isArray(all)).toBe(true);
    const ids = all.map(id);
    for (const n of LOCAL) expect(ids).toContain(`local:${n}:`);
    for (const n of CATALOG_ONLY) expect(ids).toContain(`catalog:${n}:`);
    expect(all.filter((r) => r.source === "managed")).toHaveLength(CLONES.length);
  });

  it.each([1, 2, 3])(
    "pages of %i join up to the whole list, none twice",
    async (limit) => {
      const all = ((await ask("all=1")).body as Row[]).map(id).sort();
      const paged = (await walk(limit)).map(id);
      expect(new Set(paged).size).toBe(paged.length);
      expect([...paged].sort()).toEqual(all);
    },
  );

  it("walks clones of app, app-web and app.v2 one at a time, skipping none", async () => {
    const clones = (await walk(1))
      .filter((r) => r.source === "managed")
      .map((r) => `${r.name}/${r.currentBranch}`);
    expect(clones).toEqual(CLONES.map(([r, b]) => `${r}/${b}`));
  });

  it("?q matches a local checkout by a slug only the catalog knows", async () => {
    const rows = await walk(2, "&q=far-meadow");
    expect(rows.map(id)).toEqual(["local:team/west:"]);
  });

  it("?q matches a clone by a slug only the catalog knows", async () => {
    const rows = await walk(2, "&q=storefront");
    expect(rows.map((r) => `${r.source}:${r.name}`)).toEqual(["managed:app-web"]);
  });

  it("refuses a cursor with the old two-part key", async () => {
    const old = encodeCursor(LIST, { key: [1, "app::main"], id: "app::main" });
    const { status, body } = await ask(`limit=1&cursor=${old}`);
    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe("bad_cursor");
  });

  it.each([
    [
      "a cursor going back",
      () =>
        `cursor=${encodeCursor(LIST, { key: [0, "north", ""], id: "north" }, "prev")}`,
    ],
    ["the last page", () => "at=last"],
    ["page 2", () => "page=2"],
  ])("refuses %s: the list pages forward only", async (_what, q) => {
    const { status, body } = await ask(`limit=1&${q()}`);
    expect(status).toBe(400);
    expect((body as { code: string }).code).toBe("bad_page");
  });
});
