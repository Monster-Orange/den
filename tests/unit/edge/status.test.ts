/**
 * Read-only status for stacks and the edge: what `stack ls/health` and
 * `edge status` print, as data (and what /api/stacks and /api/edge return).
 * Docker and the keychain are injected; nothing is run.
 */
import { describe, expect, it } from "@jest/globals";
import { stackStatuses } from "../../../src/shared/stacks/status.js";
import {
  CERT_ISSUED_DEPRECATION,
  edgeStatus,
} from "../../../src/shared/edge/status.js";
import type { StackConfig } from "../../../src/shared/stacks/types.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

const edge: EdgeConfig = {
  org: "acme",
  domain: "acme.localhost",
  aliases: [],
  image: "traefik:v3",
  workspaces: [],
  routes: { web: "http://localhost:3000" },
  ports: { http: 80, https: 443 },
  stateDir: "/nonexistent/edge-state",
  tls: { strategy: "mkcert", ca: null },
  tlsFrom: "explicit",
  httpsRedirect: true,
  dockerLabels: null,
  include: null,
  mounts: {},
  networks: [],
  args: [],
};

const stack = (over: Partial<StackConfig>): StackConfig => ({
  name: "s",
  repo: "r",
  files: ["docker-compose.yml"],
  routes: {},
  generate: [],
  uses: [],
  env: {},
  profiles: [],
  ...over,
});

describe("stackStatuses", () => {
  const stacks = {
    shop: stack({
      name: "shop",
      repo: "shop",
      dir: "deploy",
      routes: { app: "web:80", api: "api:3001" },
      uses: ["db"],
    }),
    db: stack({ name: "db", repo: "db" }),
  };
  const ctx = { edge, stacks, workspace: "main" };

  it("lists name, repo, project, routes and uses (no health unless asked)", () => {
    const out = stackStatuses(ctx);
    expect(out).toEqual([
      {
        name: "shop",
        repo: "shop",
        dir: "deploy",
        project: "shop-main",
        routes: [
          {
            name: "app",
            url: "https://app.shop.acme.localhost",
            target: "web:80",
          },
          {
            name: "api",
            url: "https://api.shop.acme.localhost",
            target: "api:3001",
          },
        ],
        uses: ["db"],
      },
      {
        name: "db",
        repo: "db",
        dir: null,
        project: "db-main",
        routes: [],
        uses: [],
      },
    ]);
  });

  it("adds container health from the injected check", () => {
    const seen: string[] = [];
    const out = stackStatuses(ctx, {
      health: true,
      healthOf: (_c, s) => {
        seen.push(s.name);
        return s.name === "shop"
          ? { ok: true, detail: "2 container(s) running" }
          : { ok: false, detail: "db-main: not running" };
      },
    });
    expect(seen).toEqual(["shop", "db"]);
    expect(out.map((s) => s.health)).toEqual([
      { ok: true, detail: "2 container(s) running" },
      { ok: false, detail: "db-main: not running" },
    ]);
  });

  it("a health check that throws reads as unknown (ok null), never as a crash", () => {
    const out = stackStatuses(ctx, {
      health: true,
      healthOf: () => {
        throw new Error("docker: not found");
      },
    });
    expect(out[0].health).toEqual({ ok: null, detail: "docker: not found" });
  });
});

describe("edgeStatus", () => {
  it("reports up/down, routes and cert names", () => {
    const up = edgeStatus(edge, {
      containerState: () => "running",
      caTrusted: () => true,
      issuedNames: () => ["acme.localhost", "*.acme.localhost"],
    });
    expect(up).toEqual({
      org: "acme",
      container: "acme-edge",
      state: "running",
      up: true,
      ports: { http: 80, https: 443 },
      network: "acme-edge",
      domains: ["acme.localhost"],
      routes: [
        {
          name: "web",
          url: "https://web.acme.localhost",
          upstream: "http://localhost:3000",
        },
      ],
      certNames: ["acme.localhost", "*.acme.localhost"],
      certIssuedByDen: true,
      certIssued: true,
      caTrusted: true,
      https: {
        strategy: "mkcert",
        certs: "den",
        serving: null,
        detail: "not probed",
      },
      deprecated: { certIssued: CERT_ISSUED_DEPRECATION },
      tls: {
        strategy: "mkcert",
        implicit: false,
        from: "explicit",
        ca: "/nonexistent/edge-state/ca",
      },
      included: [],
      includedErrors: [],
      stacks: [],
      stackErrors: [],
    });
  });

  it("tls: none: http URLs, no cert names, no CA to trust", () => {
    const st = edgeStatus(
      { ...edge, tls: { strategy: "none" } },
      {
        containerState: () => "running",
        caTrusted: () => false,
        issuedNames: () => null,
      },
    );
    expect(st.routes[0].url).toBe("http://web.acme.localhost");
    expect(st.certNames).toEqual([]);
    expect(st.caTrusted).toBeNull();
    expect(st.tls).toEqual({
      strategy: "none",
      implicit: false,
      from: "explicit",
      ca: null,
    });
  });

  it("down with no cert issued yet: the planned names, flagged not issued", () => {
    const down = edgeStatus(edge, {
      containerState: () => "absent",
      caTrusted: () => false,
      issuedNames: () => null,
    });
    expect(down.up).toBe(false);
    expect(down.state).toBe("absent");
    expect(down.certIssued).toBe(false);
    expect(down.certNames).toEqual(["acme.localhost", "*.acme.localhost"]);
  });
});
