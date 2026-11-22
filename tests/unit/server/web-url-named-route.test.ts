/**
 * The one-time address (web.url) and a route the distribution names.
 *
 * Den makes the web UI's edge route from the brand slug (acme.<domain>).
 * A distribution can add its own route to the same web server in
 * edge.routes (den.<domain>) because only that name is reachable from
 * other machines. The migration took the brand route, as it came first,
 * so the address became a name only the host opens. Each clause:
 *
 * 1. With a route named in edge.routes, the migration takes it over the
 *    brand route (https first, never loopback, as before).
 * 2. An install the migration already gave the brand route (unconfirmed,
 *    url_from set) is corrected to the named route at start, once, with an
 *    activity row, and stays unconfirmed for doctor.
 * 3. A confirmed web.url, or one a person set (no url_from), never changes.
 * 4. With no named route, the migration is as it was.
 * 5. Doctor's unconfirmed row names the other edge addresses.
 *
 * Invented names only (acme, local.example.com).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readEdgeConfig } from "../../../src/shared/edge/config.js";
import {
  webRouteFindings,
  webRouteHosts,
} from "../../../src/shared/edge/render.js";
import { migrateWebUrl } from "../../../src/shared/web-url.js";
import {
  setConfigAuditSink,
  type ConfigAuditRow,
} from "../../../src/shared/config-audit.js";
import type { UserConfig } from "../../../src/shared/den-config.js";
import { addressLines } from "../../../src/ui/cli/doctor-command.js";

const BRAND = "https://acme.local.example.com";
const NAMED = "https://den.local.example.com";
const FROM = "the edge route to this install";

function root(team: string, user?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-url-named-"));
  fs.mkdirSync(path.join(dir, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "den.yml"), team);
  if (user)
    fs.writeFileSync(path.join(dir, "config", "local", "user.yml"), user);
  return dir;
}
const edge =
  "brand:\n  name: Acme\nedge:\n  org: acme\n  domain: local.example.com\n";
const withNamed =
  edge + "  routes:\n    den: http://host.docker.internal:7777\n";

/** What the server hands migrateWebUrl at start (index.ts). */
const findings = (dir: string) =>
  webRouteFindings(readEdgeConfig(dir), new Set([7777])).map((r) => ({
    url: r.url,
    from: FROM,
    named: r.named,
  }));

const store = (init: UserConfig = {}) => {
  let user: UserConfig = init;
  return {
    read: () => user,
    merge: (p: Partial<UserConfig>) => (user = { ...user, ...p }),
    get: () => user,
  };
};

let rows: ConfigAuditRow[] = [];
beforeAll(() => setConfigAuditSink((r) => void rows.push(r)));
afterEach(() => {
  rows = [];
});
afterAll(() => setConfigAuditSink(null));

describe("the edge config says which routes are named on purpose", () => {
  it("marks the edge.routes one named and the brand one not, in webRouteHosts' order", () => {
    const cfg = readEdgeConfig(root(withNamed));
    const f = webRouteFindings(cfg, new Set([7777]));
    expect(f.map((r) => [r.url, r.named])).toEqual([
      [BRAND, false],
      [NAMED, true],
    ]);
    // Other callers see webRouteHosts as before.
    expect(webRouteHosts(cfg, new Set([7777]))).toEqual([
      { host: "acme.local.example.com", url: BRAND },
      { host: "den.local.example.com", url: NAMED },
    ]);
  });
});

describe("clause 1: a fresh migration takes the named route", () => {
  it("a brand plus routes: { den: <web port> } migrates to den.<domain>", () => {
    const s = store();
    const w = migrateWebUrl(() => findings(root(withNamed)), s.merge, s.read);
    expect(w).toEqual({ url: NAMED, confirmed: false, from: FROM });
    expect(s.get().web).toMatchObject({ url: NAMED, url_confirmed: false });
  });

  it("still never takes a loopback named route", () => {
    const s = store();
    const w = migrateWebUrl(
      () => [
        { url: BRAND, from: FROM, named: false },
        { url: "https://den.localhost", from: FROM, named: true },
      ],
      s.merge,
      s.read,
    );
    expect(w?.url).toBe(BRAND);
  });

  it("keeps https first: an https brand route beats an http named one", () => {
    const s = store();
    const w = migrateWebUrl(
      () => [
        { url: BRAND, from: FROM, named: false },
        { url: "http://den.local.example.com", from: FROM, named: true },
      ],
      s.merge,
      s.read,
    );
    expect(w?.url).toBe(BRAND);
  });
});

describe("clause 2: an install the migration gave the brand route is corrected once", () => {
  it("moves to the named route, unconfirmed, with an activity row", () => {
    const s = store({
      web: { url: BRAND, url_confirmed: false, url_from: FROM },
    });
    const dir = root(withNamed);
    const w = migrateWebUrl(() => findings(dir), s.merge, s.read);
    expect(w?.url).toBe(NAMED);
    expect(w?.confirmed).toBe(false);
    expect(w?.from).toContain(FROM);
    expect(w?.from).toContain(BRAND);
    expect(s.get().web).toMatchObject({ url: NAMED, url_confirmed: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].verb).toBe("web-url");
    expect(rows[0].detail).toContain(`${BRAND} → ${NAMED}`);

    // Once: the next start leaves it, and writes nothing.
    rows = [];
    const again = migrateWebUrl(() => findings(dir), s.merge, s.read);
    expect(again?.url).toBe(NAMED);
    expect(rows).toHaveLength(0);
  });
});

describe("clause 3: a confirmed or person-set web.url never changes", () => {
  it.each<[string, UserConfig["web"]]>([
    ["confirmed", { url: BRAND, url_from: FROM }],
    [
      "confirmed explicitly",
      { url: BRAND, url_confirmed: true, url_from: FROM },
    ],
    ["set by a person", { url: BRAND }],
    [
      "set by a person, unconfirmed flag but no url_from",
      { url: BRAND, url_confirmed: false },
    ],
  ])("%s", (_, web) => {
    const s = store({ web });
    const w = migrateWebUrl(() => findings(root(withNamed)), s.merge, s.read);
    expect(w?.url).toBe(BRAND);
    expect(s.get().web).toEqual(web);
    expect(rows).toHaveLength(0);
  });
});

describe("clause 4: no named route, as before", () => {
  it("takes the brand route", () => {
    const s = store();
    const w = migrateWebUrl(() => findings(root(edge)), s.merge, s.read);
    expect(w).toEqual({ url: BRAND, confirmed: false, from: FROM });
  });

  it("leaves an unconfirmed brand-route address alone", () => {
    const web = { url: BRAND, url_confirmed: false, url_from: FROM };
    const s = store({ web });
    const w = migrateWebUrl(() => findings(root(edge)), s.merge, s.read);
    expect(w?.url).toBe(BRAND);
    expect(s.get().web).toEqual(web);
    expect(rows).toHaveLength(0);
  });
});

describe("clause 5: doctor names the other edge addresses while unconfirmed", () => {
  it("lists them on the unconfirmed row", () => {
    const r = addressLines(
      { url: NAMED, confirmed: false, from: FROM },
      "Den",
      "den",
      null,
      null,
      [NAMED, BRAND],
    );
    expect(r.check.status).toBe("warn");
    expect(r.check.detail).toContain(BRAND);
    expect(r.check.detail).toContain(`den web url ${NAMED}`);
  });

  it("says nothing more once confirmed", () => {
    const r = addressLines(
      { url: NAMED, confirmed: true },
      "Den",
      "den",
      null,
      null,
      [NAMED, BRAND],
    );
    expect(r.check.detail).toBe(NAMED);
  });
});
