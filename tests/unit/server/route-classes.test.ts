/**
 * The route table (route-classes.ts, SEC-1 §3/§4): every route the server
 * dispatches has a class, and the GETs that run or change something are
 * the ones request-guard checks as mutations.
 *
 * The enumeration is a scan of the dispatchers' source: every `pathname
 * === "…"` / `!== "…"` and `pathname.startsWith("…")`, and every route
 * regex (`const *_PATH = /^…/`). A new route that isn't in the table fails
 * here.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  isMutatingGet,
  REGEX_ROUTES,
  routeClass,
  ROUTES,
} from "../../../src/ui/server/route-classes.js";

const SERVER = path.join(process.cwd(), "src", "ui", "server");
/** The modules whose code dispatches on the path. */
const DISPATCHERS = fs
  .readdirSync(SERVER)
  .filter(
    (f) => f === "index.ts" || f === "ui-assets.ts" || /-routes\.ts$/.test(f),
  );

/**
 * Prefix checks that guard a group, not a route: the /api frame (R26) and
 * the local-dev guard over /api/workspace*, /api/service*.
 */
const GROUP_GUARDS = new Set([
  "/api/",
  "/api/service",
  "/api/workspace/",
  "/api/workspaces",
]);
/** Exact checks that are the /api frame, not a route. */
const FRAME = new Set(["/api"]);

interface Found {
  file: string;
  path: string;
  prefix: boolean;
}
function scan(): Found[] {
  const out: Found[] = [];
  for (const file of DISPATCHERS) {
    const src = fs.readFileSync(path.join(SERVER, file), "utf-8");
    for (const m of src.matchAll(
      /pathname\s*[!=]==\s*("([^"]+)"|`([^`]+)`)/g,
    )) {
      const p = (m[2] ?? m[3]).replace(/\$\{[^}]+\}/g, ":cli");
      if (!FRAME.has(p)) out.push({ file, path: p, prefix: false });
    }
    for (const m of src.matchAll(/pathname\.startsWith\(\s*"([^"]+)"\s*\)/g))
      if (!GROUP_GUARDS.has(m[1])) out.push({ file, path: m[1], prefix: true });
  }
  return out;
}
const tablePaths = new Set(ROUTES.map((r) => r.path));

describe("the route table covers every dispatched route", () => {
  const found = scan();

  it("finds the dispatchers' routes (the scan works)", () => {
    expect(DISPATCHERS).toEqual(
      expect.arrayContaining([
        "index.ts",
        "workspace-routes.ts",
        "agent-routes.ts",
      ]),
    );
    expect(found.length).toBeGreaterThan(80);
    expect(found.map((f) => f.path)).toContain("/api/service/exec");
  });

  it("every `pathname === …` and `startsWith(…)` route has a class", () => {
    const missing = found
      .filter((f) => !tablePaths.has(f.prefix ? `${f.path}*` : f.path))
      .map((f) => `${f.file}: ${f.path}${f.prefix ? "*" : ""}`);
    expect(missing).toEqual([]);
  });

  it("every route regex is mapped, to entries in the table", () => {
    const regexes: string[] = [];
    for (const file of DISPATCHERS) {
      const src = fs.readFileSync(path.join(SERVER, file), "utf-8");
      for (const m of src.matchAll(/const\s+(\w+)\s*=\s*\/\^\\\//g))
        regexes.push(`${file}:${m[1]}`);
    }
    expect(regexes.length).toBeGreaterThan(0);
    for (const r of regexes) {
      expect([r, REGEX_ROUTES[r] !== undefined]).toEqual([r, true]);
      for (const p of REGEX_ROUTES[r])
        expect([r, p, tablePaths.has(p)]).toEqual([r, p, true]);
    }
  });

  it("no entry is stale: each is in the dispatchers' source or a mapped regex", () => {
    const seen = new Set([
      ...found.map((f) => (f.prefix ? `${f.path}*` : f.path)),
      ...Object.values(REGEX_ROUTES).flat(),
    ]);
    expect(ROUTES.map((r) => r.path).filter((p) => !seen.has(p))).toEqual([]);
  });
});

describe("the classes", () => {
  it("the GETs that run something are shell-grade, and get the mutating-GET check", () => {
    for (const p of [
      "/api/service/exec",
      "/api/run",
      "/api/workspace/exec",
      "/api/workspace/sync",
      "/api/aws/login",
    ]) {
      expect([p, routeClass("GET", p)]).toEqual([p, "shell-grade"]);
      expect([p, isMutatingGet("GET", p)]).toEqual([p, true]);
    }
  });

  it("read-only GETs are not checked as mutations", () => {
    for (const p of [
      "/",
      "/api/health",
      "/api/health/stream",
      "/api/service/logs",
      "/api/release/deploy",
      "/api/settings",
      "/api/release/config",
      "/api/workspaces/north/agents",
      "/vendor/elk.bundled.js",
    ]) {
      expect([p, routeClass("GET", p)]).toEqual([p, "readonly"]);
      expect([p, isMutatingGet("GET", p)]).toEqual([p, false]);
    }
  });

  it("mutations are listed with their class; agent start and resume are shell-grade", () => {
    expect(routeClass("POST", "/api/settings")).toBe("mutating");
    expect(routeClass("DELETE", "/api/workspaces/services")).toBe("mutating");
    expect(routeClass("POST", "/api/workspaces/north/agents")).toBe(
      "shell-grade",
    );
    expect(
      routeClass("POST", "/api/workspaces/north/agents/planner/resume"),
    ).toBe("shell-grade");
    expect(
      routeClass("POST", "/api/workspaces/north/agents/planner/stop"),
    ).toBe("mutating");
    // A POST is a mutation by method, not by the table (isMutatingGet is GETs only).
    expect(isMutatingGet("POST", "/api/run")).toBe(false);
  });

  it("an unknown route has no class", () => {
    expect(routeClass("GET", "/api/no-such-route")).toBeNull();
  });
});
