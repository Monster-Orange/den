/**
 * The read-only endpoints the MCP `stacks`, `edge_status` and `run_tests`
 * (security pre-flight) tools read: /api/stacks, /api/edge and
 * /api/security/plan. Every collaborator is injected; nothing runs docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  handleReadonlyRoutes,
  type ReadonlyRouteDeps,
} from "../../../src/ui/server/readonly-routes.js";

const calls: { stacks: unknown[]; plan: unknown[] } = { stacks: [], plan: [] };

const deps: ReadonlyRouteDeps = {
  workspaceExists: (name) => name === "default",
  stacks: (opts) => {
    calls.stacks.push(opts);
    return {
      workspace: opts.workspace ?? "default",
      stackWorkspace: "main",
      stacks: [
        {
          name: "shop",
          repo: "shop",
          dir: null,
          project: "shop-main",
          routes: [
            {
              name: "app",
              url: "https://app.shop.acme.localhost",
              target: "web:80",
            },
          ],
          uses: [],
          ...(opts.health
            ? { health: { ok: true, detail: "1 container(s) running" } }
            : {}),
        },
      ],
    };
  },
  edge: () => ({
    org: "acme",
    container: "acme-edge",
    state: "running",
    up: true,
    ports: null,
    network: "acme-edge",
    domains: ["acme.localhost"],
    routes: [],
    certNames: ["acme.localhost", "*.acme.localhost"],
    certIssued: true,
    caTrusted: null,
  }),
  securityPlan: async (args) => {
    calls.plan.push(args);
    return args.service === "shop/evil"
      ? {
          exitCode: 1,
          log: [],
          errors: [
            'Security plan refused: Refusing to scan "evil.example.com": not an owned host',
          ],
        }
      : { exitCode: 0, log: ["[dry-run] 1 scan(s) planned"], errors: [] };
  },
};

let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    void handleReadonlyRoutes(req, res, url.pathname, url, deps).then(
      (handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function get(path: string, method = "GET") {
  const res = await fetch(base + path, { method });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

describe("/api/stacks", () => {
  it("returns stacks with health by default", async () => {
    const r = await get("/api/stacks");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      stackWorkspace: "main",
      stacks: [{ name: "shop", project: "shop-main", health: { ok: true } }],
    });
    expect(calls.stacks.at(-1)).toEqual({ workspace: null, health: true });
  });

  it("health=0 skips the docker check; workspace is passed through", async () => {
    const r = await get("/api/stacks?workspace=default&health=0");
    expect(r.status).toBe(200);
    expect((r.json as { stacks: object[] }).stacks[0]).not.toHaveProperty(
      "health",
    );
    expect(calls.stacks.at(-1)).toEqual({
      workspace: "default",
      health: false,
    });
  });

  it("an unknown workspace is a 400", async () => {
    expect((await get("/api/stacks?workspace=nope")).status).toBe(400);
  });

  it("is read-only: other methods are refused", async () => {
    expect((await get("/api/stacks", "POST")).status).toBe(405);
  });
});

describe("/api/edge", () => {
  it("returns the edge's state, routes and cert names", async () => {
    const r = await get("/api/edge");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      configured: true,
      up: true,
      certNames: ["acme.localhost", "*.acme.localhost"],
    });
  });

  it("no edge configured: configured false with the reason, not a 500", async () => {
    const r = await new Promise<{ status: number; json: unknown }>(
      (resolve) => {
        const s = http.createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://localhost");
          void handleReadonlyRoutes(req, res, url.pathname, url, {
            ...deps,
            edge: () => {
              throw new Error("edge.org and edge.domain are required");
            },
          });
        });
        s.listen(0, "localhost", async () => {
          const port = (s.address() as AddressInfo).port;
          const res = await fetch(`http://localhost:${port}/api/edge`);
          const json = await res.json();
          s.close();
          resolve({ status: res.status, json });
        });
      },
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      configured: false,
      error: "edge.org and edge.domain are required",
    });
  });
});

describe("/api/security/plan", () => {
  it("runs the CLI's dry-run plan and reports it", async () => {
    const r = await get(
      "/api/security/plan?env=local&mode=baseline&service=shop/api",
    );
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      ok: true,
      exitCode: 0,
      log: ["[dry-run] 1 scan(s) planned"],
      errors: [],
    });
    expect(calls.plan.at(-1)).toEqual({
      env: "local",
      mode: "baseline",
      service: "shop/api",
    });
  });

  it("a host outside security.owned_hosts comes back refused", async () => {
    const r = await get("/api/security/plan?env=local&service=shop/evil");
    expect(r.json).toMatchObject({ ok: false, exitCode: 1 });
    expect(JSON.stringify(r.json)).toMatch(/not an owned host/);
  });

  it("validates env and mode", async () => {
    expect((await get("/api/security/plan")).status).toBe(400);
    expect((await get("/api/security/plan?env=local&mode=nuke")).status).toBe(
      400,
    );
  });
});
