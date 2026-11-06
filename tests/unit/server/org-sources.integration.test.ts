/**
 * ORG-1d on the web API (ORG-SPEC §1, C1-C3):
 *   - With no ORG-1d keys, `/api/orgs`, `?repos=1` and `/api/release/config`
 *     are byte-identical to 0.2.8-dev.0: the goldens below were captured
 *     from HEAD 3185e9d against this same distribution.
 *   - With them: an org spanning two GitHub owners, one owner split across
 *     two orgs by an explicit `repos`, an org with no source whose repo has
 *     only a `remote:`, and the legacy fallback. A claimed owner is not
 *     listed, and the no-source org's repo is hidden from releases.
 *
 * The real web server in throwaway distributions; invented orgs only.
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
const servers: SlowGitServer[] = [];

function distribution(
  name: string,
  denYml: string[],
  catalog: string[],
  workspaces: string[],
): string {
  const root = path.join(tmp, name);
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), [...denYml, ""].join("\n"));
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    [...catalog, ""].join("\n"),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [...workspaces, ""].join("\n"),
  );
  return root;
}

const RELEASE = [
  "release:",
  "  repos:",
  "    - { name: acme-api, wave: 0 }",
  "    - { name: widget, wave: 1 }",
];

let legacy: SlowGitServer;
let model: SlowGitServer;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-org-sources-"));
  const legacyRoot = distribution(
    "legacy",
    [
      "environments: [local]",
      "github_org: acme",
      "orgs:",
      '  globex: { label: Globex Corp, color: "#0af" }',
      "  Initech: { label: Initech Inc }",
      "  umbrella: {}",
      ...RELEASE,
    ],
    [
      "acme-api: { gh: acme/acme-api }",
      "globex-web: { gh: Globex/globex-web }",
      "initech-db: { gh: initech/initech-db }",
      "hooli-app: { gh: hooli/hooli-app }",
      "loose: { gh: '' }",
      "widget: { gh: acme/widget }",
    ],
    [
      "active: [main, client, mixed]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      "      acme-api: { mode: managed }",
      "      loose: { mode: managed }",
      "  client:",
      "    services:",
      "      globex-web: { mode: managed }",
      "  mixed:",
      "    services:",
      "      initech-db: { mode: managed }",
      "      hooli-app: { mode: managed }",
    ],
  );
  const modelRoot = distribution(
    "model",
    [
      "environments: [local]",
      "github_org: acme",
      "orgs:",
      "  acme-group:",
      "    label: Acme Group",
      "    sources:",
      "      - { host: github, owner: acme }",
      "      - { host: github, owner: Acme-Labs }",
      "  globex-red: { label: Globex Red, repos: [globex-billing] }",
      "  globex-blue:",
      '    color: "#00f"',
      "    sources: [{ host: github, owner: globex }]",
      "  initech: { sources: [], repos: [widget] }",
      ...RELEASE,
    ],
    [
      "acme-api: { gh: acme/acme-api }",
      "labs-tool: { gh: acme-labs/labs-tool }",
      "globex-billing: { gh: globex/globex-billing }",
      "globex-web: { gh: Globex/globex-web }",
      `widget: { remote: ${path.join(tmp, "bare", "widget.git")} }`,
      "hooli-app: { gh: hooli/hooli-app }",
    ],
    [
      "active: [main, red, blue, lab, hooli]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      "      acme-api: { mode: managed }",
      "      labs-tool: { mode: managed }",
      "  red:",
      "    services:",
      "      globex-billing: { mode: managed }",
      "  blue:",
      "    services:",
      "      globex-web: { mode: managed }",
      "  lab:",
      "    services:",
      "      widget: { mode: managed }",
      "  hooli:",
      "    services:",
      "      hooli-app: { mode: managed }",
    ],
  );
  legacy = await startSlowGitServer({
    tmp,
    root: legacyRoot,
    slow: [],
    delayS: 0,
  });
  servers.push(legacy);
  model = await startSlowGitServer({
    tmp,
    root: modelRoot,
    slow: [],
    delayS: 0,
  });
  servers.push(model);
}, 90_000);

afterAll(async () => {
  for (const s of servers) await s.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Captured from HEAD 3185e9d (0.2.8-dev.0) against the "legacy" distribution.
const GOLDEN_ORGS =
  "[" +
  '{"id":"globex","label":"Globex Corp","color":"#0af","default":false,"workspaces":["client"]},' +
  '{"id":"Initech","label":"Initech Inc","default":false,"workspaces":[]},' +
  '{"id":"umbrella","label":"umbrella","default":false,"workspaces":[]},' +
  '{"id":"acme","label":"acme","default":true,"workspaces":["main","mixed"]},' +
  '{"id":"Globex","label":"Globex","default":false,"workspaces":[]},' +
  '{"id":"initech","label":"initech","default":false,"workspaces":[]},' +
  '{"id":"hooli","label":"hooli","default":false,"workspaces":[]}' +
  "]";
const GOLDEN_REPOS =
  '{"acme-api":"acme","globex-web":"Globex","initech-db":"initech","hooli-app":"hooli","loose":"","widget":"acme"}';
const GOLDEN_RELEASE_REPOS =
  '[{"workflow":"cd.yml","wave":0,"name":"acme-api"},{"workflow":"cd.yml","wave":1,"name":"widget"}]';

describe("no ORG-1d keys: byte-identical to 0.2.8-dev.0", () => {
  it("GET /api/orgs", async () => {
    const r = await legacy.timed("/api/orgs");
    expect(r.status).toBe(200);
    expect(r.body).toBe(GOLDEN_ORGS);
  }, 30_000);

  it("GET /api/orgs?repos=1", async () => {
    const r = await legacy.timed("/api/orgs?repos=1");
    expect(r.body).toBe(`{"orgs":${GOLDEN_ORGS},"repos":${GOLDEN_REPOS}}`);
  }, 30_000);

  it("GET /api/release/config repos", async () => {
    const r = await legacy.timed("/api/release/config");
    const cfg = JSON.parse(r.body) as { repos: unknown };
    expect(JSON.stringify(cfg.repos)).toBe(GOLDEN_RELEASE_REPOS);
  }, 30_000);
});

describe("ORG-1d: orgs are Den's own; sources are bindings", () => {
  type Entry = { id: string; label: string; workspaces: string[] };

  it("lists the orgs, not the owners their sources claim", async () => {
    const r = await model.timed("/api/orgs");
    expect(r.status).toBe(200);
    const orgs = JSON.parse(r.body) as Entry[];
    expect(orgs.map((o) => [o.id, o.label, o.workspaces])).toEqual([
      ["acme-group", "Acme Group", ["main"]],
      ["globex-red", "Globex Red", ["red"]],
      ["globex-blue", "globex-blue", ["blue"]],
      ["initech", "initech", ["lab"]],
      ["hooli", "hooli", ["hooli"]],
    ]);
    // No source key leaks onto the entries (C3).
    for (const o of orgs)
      expect(Object.keys(o).sort()).toEqual(
        expect.arrayContaining(["default", "id", "label", "workspaces"]),
      );
    expect(JSON.stringify(orgs)).not.toMatch(/sources|"repos"/);
  }, 30_000);

  it("?repos=1 maps each repo to its org: listed, claimed, then the GitHub owner", async () => {
    const r = await model.timed("/api/orgs?repos=1");
    const body = JSON.parse(r.body) as { repos: Record<string, string> };
    expect(body.repos).toEqual({
      "acme-api": "acme-group", // a source claims acme
      "labs-tool": "acme-group", // …and acme-labs, case-insensitively
      "globex-billing": "globex-red", // listed outright: beats globex-blue's source
      "globex-web": "globex-blue", // the rest of owner globex
      widget: "initech", // no source, a plain remote:
      "hooli-app": "hooli", // the legacy fallback, unchanged
    });
  }, 30_000);

  it("hides the no-source org's repo from releases", async () => {
    const r = await model.timed("/api/release/config");
    const cfg = JSON.parse(r.body) as { repos: { name: string }[] };
    expect(cfg.repos.map((x) => x.name)).toEqual(["acme-api"]);
  }, 30_000);
});
