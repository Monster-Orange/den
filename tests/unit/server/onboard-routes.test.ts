/**
 * ON-3's read routes (onboard-routes.ts): GET /api/onboard/status,
 * /api/onboard/repos and /api/onboard/manifest, what the MCP tools
 * onboard_status, repos_detect and manifest_draft read and a page can
 * show. They are reads in the route table, refuse anything but GET, and
 * apply the path rule (inside home, outside Den's state folder).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  handleOnboardRoutes,
  type OnboardRouteDeps,
} from "../../../src/ui/server/onboard-routes.js";
import {
  isMutatingGet,
  routeClass,
} from "../../../src/ui/server/route-classes.js";
import { validateManifest } from "../../../src/shared/manifest/validate-manifest.js";

let tmp = "";
let home = "";
let server: http.Server;
let base = "";
const seenViaMcp: boolean[] = [];
const savedManifestsDir = process.env.DEN_MANIFESTS_DIR;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-on3r-")));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".acme"), { recursive: true });
  fs.mkdirSync(path.join(home, "code", "acme", ".git"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "code", "acme", "Makefile"),
    "up:\n\t@echo up\n",
  );
  process.env.DEN_MANIFESTS_DIR = path.join(tmp, "dist", "manifests");
  const deps: OnboardRouteDeps = {
    rules: () => ({ home, stateDir: path.join(home, ".acme") }),
    validate: (m) => validateManifest(m),
    registered: () => [],
    bin: () => "./bin/acme",
    status: async ({ viaMcp }) => {
      seenViaMcp.push(viaMcp);
      return {
        ok: false,
        checks: [{ id: "repos", status: "todo", detail: "no repos added yet" }],
        next: { id: "repos", step: "Add your first repo." },
      };
    },
  };
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleOnboardRoutes(req, res, url.pathname, url, deps).then((hit) => {
      if (!hit) {
        res.writeHead(404);
        res.end("not mine");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedManifestsDir === undefined) delete process.env.DEN_MANIFESTS_DIR;
  else process.env.DEN_MANIFESTS_DIR = savedManifestsDir;
});

async function get(
  p: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(base + p, init);
  const text = await r.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { text };
  }
  return { status: r.status, body };
}

const q = (p: string) => encodeURIComponent(p);

describe("the route table", () => {
  it("classifies the three routes as reads, never a mutating GET", () => {
    for (const p of [
      "/api/onboard/status",
      "/api/onboard/repos",
      "/api/onboard/manifest",
    ]) {
      expect(routeClass("GET", p)).toBe("readonly");
      expect(isMutatingGet("GET", p)).toBe(false);
    }
  });
});

describe("GET /api/onboard/status", () => {
  it("answers the checks and the next step", async () => {
    const r = await get("/api/onboard/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, next: { id: "repos" } });
  });

  it("knows when it is asked through Den's MCP (its audit header)", async () => {
    seenViaMcp.length = 0;
    await get("/api/onboard/status", { headers: { "x-den-actor": "agent" } });
    await get("/api/onboard/status");
    expect(seenViaMcp).toEqual([true, false]);
  });
});

describe("GET /api/onboard/repos", () => {
  it("scans a folder in home", async () => {
    const r = await get(
      `/api/onboard/repos?path=${q(path.join(home, "code"))}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      repos: [{ name: "acme", runs: { up: "make up" } }],
      workspaces: [{ name: "code", repos: ["acme"] }],
    });
  });

  it("refuses a folder outside home, and no path at all", async () => {
    const outside = await get(`/api/onboard/repos?path=${q(tmp)}`);
    expect(outside.status).toBe(400);
    expect(outside.body).toMatchObject({ ok: false });
    expect(String(outside.body.error)).toMatch(/outside your home folder/);
    const none = await get("/api/onboard/repos");
    expect(none.status).toBe(400);
  });
});

describe("GET /api/onboard/manifest", () => {
  it("drafts the side-car, validated, written nowhere", async () => {
    const r = await get(
      `/api/onboard/manifest?path=${q(path.join(home, "code", "acme"))}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      dryRun: true,
      validation: { valid: true },
      manifest: { source: "sidecar", written: false },
    });
    expect(fs.existsSync(path.join(tmp, "dist", "manifests"))).toBe(false);
  });

  it("refuses Den's state folder", async () => {
    const r = await get(
      `/api/onboard/manifest?path=${q(path.join(home, ".acme"))}`,
    );
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/state folder/);
  });
});

describe("only GET", () => {
  it("POST is refused with 405", async () => {
    for (const p of [
      "/api/onboard/status",
      "/api/onboard/repos",
      "/api/onboard/manifest",
    ]) {
      const r = await fetch(base + p, { method: "POST" });
      expect(r.status).toBe(405);
      await r.text();
    }
  });

  it("other paths are not this handler's", async () => {
    const r = await fetch(base + "/api/onboard/other");
    expect(r.status).toBe(404);
    await r.text();
  });
});
