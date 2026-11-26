/**
 * Every route in the server's table (route-classes.ts) is named by a test:
 * some file under tests/ or gate/ names its path, as a string or a URL
 * built from a base. Named, not proven exercised: a comment or another
 * method counts too. A new route that no test names fails here by name.
 * UNTESTED lists the routes no test named when this check began; it may
 * only shrink, and a listed route that a test now names fails until it is
 * taken off.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { ROUTES } from "../../../src/ui/server/route-classes.js";

const UNTESTED: readonly string[] = [
  "GET/HEAD /agents.html",
  "GET/HEAD /api/app-url",
  "GET/HEAD /api/gate-slots/runners",
  "GET/HEAD /api/release/branches",
  "GET/HEAD /api/release/deploy/active",
  "GET/HEAD /api/runs/last",
  "GET/HEAD /api/security/latest",
  "GET/HEAD /edge.html",
  "GET/HEAD /environments.html",
  "GET/HEAD /graph.html",
  "GET/HEAD /icon-192.png",
  "GET/HEAD /icon-512.png",
  "GET/HEAD /icon-maskable-512.png",
  "GET/HEAD /local-dev.html",
  "GET/HEAD /perf-report.js",
  "GET/HEAD /project-colour-picker.js",
  "GET/HEAD /release.html",
  "GET/HEAD /server-agent.html",
  "GET/HEAD /services.html",
  "GET/HEAD /settings.html",
  "GET/HEAD /verify.html",
  "POST /api/gate-slots/runners/revoke",
  "POST /api/workspaces/services/autostart",
];

const ROOT = process.cwd();
const SKIP = new Set([
  "tests/unit/server/route-test-inventory.test.ts",
  "tests/unit/server/route-classes.test.ts",
  "tests/unit/server/agent-write-routes.test.ts",
]);

function testFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "fixtures" && e.name !== "node_modules")
        testFiles(rel, out);
    } else if (/\.(?:ts|mjs|js)$/.test(e.name) && !SKIP.has(rel)) out.push(rel);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function pathPattern(route: string): RegExp {
  const prefix = route.endsWith("*");
  const body = route
    .replace(/\*$/, "")
    .split(/(:[A-Za-z0-9_]+)/)
    .map((part) =>
      part.startsWith(":") ? "(?:[^/\"'`\\s]+|\\$\\{[^}]+\\})" : escape(part),
    )
    .join("");
  return new RegExp(`["'\`}\\s]${body}${prefix ? "" : "(?![\\w/-])"}`);
}

const key = (r: (typeof ROUTES)[number]) => `${r.methods.join("/")} ${r.path}`;

describe("every route is named by a test", () => {
  const texts = ["tests", "gate"]
    .filter((d) => fs.existsSync(path.join(ROOT, d)))
    .flatMap((d) => testFiles(d))
    .map((f) => fs.readFileSync(path.join(ROOT, f), "utf-8"));
  const named = (route: string) => {
    const re = pathPattern(route);
    return texts.some((t) => re.test(t));
  };

  it("a route no test names is on the UNTESTED list", () => {
    const missing = ROUTES.filter((r) => !named(r.path))
      .map(key)
      .filter((k) => !UNTESTED.includes(k));
    expect(missing).toEqual([]);
  });

  it("the UNTESTED list stays true: each entry is a route, and still named by no test", () => {
    const keys = new Set(ROUTES.map(key));
    const stale = UNTESTED.filter(
      (k) => !keys.has(k) || named(k.slice(k.indexOf(" ") + 1)),
    );
    expect(stale).toEqual([]);
  });

  it("finds a path a test builds from a base URL or names in a string", () => {
    const re = pathPattern("/api/workspaces/:ws/agents/:id/details");
    expect(
      re.test("fetch(`${base}/api/workspaces/${ws}/agents/a1/details`)"),
    ).toBe(true);
    expect(re.test('get("/api/workspaces/default/agents/a1/details")')).toBe(
      true,
    );
    expect(
      re.test('get("/api/workspaces/default/agents/a1/details-more")'),
    ).toBe(false);
    expect(pathPattern("/api/requests/*").test('"/api/requests/abc"')).toBe(
      true,
    );
  });
});
