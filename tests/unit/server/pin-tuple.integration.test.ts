/**
 * Issue 402, clause 6, on a real server: pins saved before the tuple (a
 * bare id in user.yml) take the item's own project when exactly one
 * project has its repo, else none: on read (GET /api/settings) and on
 * write (any shell save stores the tuples). A bare-id list posted by an
 * older page migrates the same way. Projects, active or not:
 *
 *   alpha  shop (services shop and shop/db)
 *   beta   billing/api, common
 *   gamma  (inactive) common, and the managed clone tools
 *
 * A real server on a throwaway distribution; no browser.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { denAuth } from "./helpers/den-auth.js";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let userYml = "";
let port = 0;
let server: ChildProcess;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function call(method: string, body?: unknown) {
  const r = await fetch(`http://localhost:${port}/api/settings`, {
    method,
    headers: {
      ...denAuth(path.join(tmp, "home", ".den")),
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json()) as { shell: { pins: unknown } },
  };
}
const storedPins = () =>
  (yaml.parse(fs.readFileSync(userYml, "utf-8")) ?? {}).shell?.pins;

const OLD = ["shop", "shop/db", "billing/api", "common/web", "tools", "gone"];
const MIGRATED = [
  { item: "shop", project: "alpha" },
  { item: "shop/db", project: "alpha" },
  { item: "billing/api", project: "beta" },
  { item: "common/web", project: null },
  { item: "tools", project: "gamma" },
  { item: "gone", project: null },
];

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-pins-")));
  const root = path.join(tmp, "dist");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    yaml.stringify({
      active: ["alpha", "beta"],
      workspaces: {
        alpha: { services: { shop: {}, "shop/db": {} } },
        beta: { services: { "billing/api": {}, common: {} } },
        gamma: { services: { common: {} }, repos: { tools: "main" } },
      },
    }),
  );
  userYml = path.join(root, "config", "local", "user.yml");
  // A user.yml from before the tuple: bare ids.
  write(userYml, yaml.stringify({ shell: { pins: OLD } }));
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("issue 402, clause 6: old id-only pins migrate on a real server", () => {
  it("on read: GET /api/settings answers each pin with its item's one project, else none", async () => {
    const r = await call("GET");
    expect(r.status).toBe(200);
    expect(r.json.shell.pins).toEqual(MIGRATED);
    // Reading writes nothing.
    expect(storedPins()).toEqual(OLD);
  });

  it("on write: any shell save stores the tuples (none leaves project out)", async () => {
    expect((await call("POST", { shell: { collapsed: true } })).status).toBe(
      200,
    );
    expect(storedPins()).toEqual(
      MIGRATED.map((p) =>
        p.project === null
          ? { item: p.item }
          : { item: p.item, project: p.project },
      ),
    );
    expect((await call("GET")).json.shell.pins).toEqual(MIGRATED);
  });

  it("a bare-id list an older page posts migrates the same way; tuples keep their project", async () => {
    const r = await call("POST", {
      shell: { pins: ["billing/api", { item: "shop", project: "beta" }] },
    });
    expect(r.status).toBe(200);
    expect((await call("GET")).json.shell.pins).toEqual([
      { item: "billing/api", project: "beta" },
      { item: "shop", project: "beta" },
    ]);
  });
});
