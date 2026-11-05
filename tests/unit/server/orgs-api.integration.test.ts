/**
 * ORG-1a on the web API (ORG-SPEC C3):
 *   - `GET /api/orgs` entries gain only `default` and `workspaces`; with
 *     those two removed the response is byte for byte what it was (same
 *     entries, order and fields). `?repos=1` keeps `repos` a map from repo
 *     to its owner string.
 *   - `GET /api/<cli>/config` gains `default_org` (= github_org); its `org`
 *     stays the instance org.
 *
 * The real web server in a throwaway distribution; invented orgs only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

let tmp = "";
let srv: SlowGitServer;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-orgs-api-"));
  const root = path.join(tmp, "den");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "github_org: acme",
      "orgs:",
      '  globex: { label: Globex Corp, color: "#0af" }',
      "edge:",
      "  org: initech",
      "  domain: initech.localhost",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    [
      "acme-api: { gh: acme/acme-api }",
      "globex-web: { gh: Globex/globex-web }",
      "loose: { gh: '' }",
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [main, client]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      "      acme-api: { mode: managed }",
      "      loose: { mode: managed }",
      "  client:",
      "    services:",
      "      globex-web: { mode: managed }",
      "",
    ].join("\n"),
  );
  srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
}, 60_000);

afterAll(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** What /api/orgs answered before ORG-1a, for this distribution. */
const OLD_ORGS =
  '[{"id":"globex","label":"Globex Corp","color":"#0af"},' +
  '{"id":"acme","label":"acme"},{"id":"Globex","label":"Globex"}]';

type Entry = Record<string, unknown>;
const strip = (orgs: Entry[]) =>
  orgs.map(({ default: _d, workspaces: _w, ...rest }) => rest);

describe("GET /api/orgs", () => {
  it("adds default and workspaces only; the rest is byte-identical", async () => {
    const r = await srv.timed("/api/orgs");
    expect(r.status).toBe(200);
    const orgs = JSON.parse(r.body) as Entry[];
    expect(JSON.stringify(strip(orgs))).toBe(OLD_ORGS);
    expect(orgs.map((o) => [o.id, o.default, o.workspaces])).toEqual([
      ["globex", false, ["client"]],
      ["acme", true, ["main"]],
      ["Globex", false, []],
    ]);
    for (const o of orgs)
      expect(Object.keys(o).sort()).toEqual(
        expect.arrayContaining(["default", "id", "label", "workspaces"]),
      );
  }, 30_000);

  it("?repos=1 keeps repos a map of owner strings", async () => {
    const r = await srv.timed("/api/orgs?repos=1");
    const body = JSON.parse(r.body) as { orgs: Entry[]; repos: unknown };
    expect(Object.keys(body)).toEqual(["orgs", "repos"]);
    expect(body.repos).toEqual({
      "acme-api": "acme",
      "globex-web": "Globex",
      loose: "",
    });
    expect(JSON.stringify(strip(body.orgs))).toBe(OLD_ORGS);
  }, 30_000);
});

describe("GET /api/den/config", () => {
  it("gains default_org; org stays the instance org", async () => {
    const r = await srv.timed("/api/den/config");
    expect(r.status).toBe(200);
    const cfg = JSON.parse(r.body) as Record<string, unknown>;
    expect(cfg.default_org).toBe("acme");
    expect(cfg.github_org).toBe("acme");
    expect(cfg.org).toEqual({ id: "initech", title: "initech" });
  }, 30_000);
});
