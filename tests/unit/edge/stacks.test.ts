import { describe, it, expect } from "@jest/globals";
import * as yaml from "yaml";
import {
  containerName,
  expandEnv,
  linkedServices,
  providerServices,
  renderOverride,
  renderStackRoutes,
  routedNetworks,
  startOrder,
} from "../../../src/shared/stacks/render.js";
import type {
  ResolvedProject,
  StackConfig,
} from "../../../src/shared/stacks/types.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";

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

const ragstack = stack({
  name: "ragstack",
  routes: { app: "ragstack-server:80" },
});
const webapp = stack({
  name: "webapp",
  routes: { app: "frontend:80", api: "backend:3001" },
  uses: ["ragstack"],
  env: { RAG_PROXY_TARGET: "http://{ragstack.ragstack-server}:80" },
});
const all = { ragstack, webapp };

const resolved: ResolvedProject = {
  name: "webapp-main",
  services: {
    frontend: {
      environment: {
        RAG_PROXY_TARGET: "http://ragstack-main-ragstack-server-1:80",
      },
      ports: [{ target: 80, published: "3000" }],
      networks: { "ai-expert-network": null },
    },
    backend: {
      ports: [{ target: 3001 }],
      networks: { "ai-expert-network": null },
    },
    postgres: { networks: { "ai-expert-network": null } },
  },
  networks: { "ai-expert-network": { name: "webapp-main_ai-expert-network" } },
};

const edge: EdgeConfig = {
  org: "globex",
  domain: "globex.localhost",
  aliases: ["globex.internal"],
  image: "traefik:v3.7.17",
  workspaces: [],
  routes: {},
  ports: null,
  stateDir: "/tmp/x",
};

describe("stack planning", () => {
  it("starts providers before the stacks that use them, and rejects cycles", () => {
    expect(startOrder(["webapp"], all)).toEqual(["ragstack", "webapp"]);
    const loop = {
      a: stack({ name: "a", uses: ["b"] }),
      b: stack({ name: "b", uses: ["a"] }),
    };
    expect(() => startOrder(["a"], loop)).toThrow(/cycle: a → b → a/);
    expect(() => startOrder(["nope"], all)).toThrow(/unknown stack/);
  });

  it("expands {stack.service} to the provider's container name", () => {
    expect(expandEnv(webapp.env, "main", all)).toEqual({
      RAG_PROXY_TARGET: "http://ragstack-main-ragstack-server-1:80",
    });
    expect(providerServices(webapp)).toEqual({
      ragstack: ["ragstack-server"],
    });
    expect(() => expandEnv({ X: "{ghost.svc}" }, "main", all)).toThrow(
      /unknown stack "ghost"/,
    );
  });

  it("resets a pinned container_name so workspaces don't collide", () => {
    const pinned: ResolvedProject = {
      name: "webapp-pr-12",
      services: { backend: { container_name: "ai-expert-demo-backend" } },
    };
    expect(
      renderOverride(stack({ name: "webapp" }), pinned, "pr-12"),
    ).toContain('"backend":\n    container_name: !reset null');
    expect(containerName("webapp-pr-12", "backend")).toBe(
      "webapp-pr-12-backend-1",
    );
  });

  it("replaces a service's healthcheck test when the manifest gives one", () => {
    const text = renderOverride(
      stack({
        name: "webapp",
        healthchecks: {
          frontend: [
            "CMD",
            "wget",
            "-q",
            "--spider",
            "http://127.0.0.1:80/health",
          ],
        },
      }),
      { name: "webapp-main", services: { frontend: {}, backend: {} } },
      "main",
    );
    expect(text).toContain(
      '"frontend":\n    healthcheck:\n      test: ["CMD","wget","-q","--spider","http://127.0.0.1:80/health"]',
    );
    expect(text).not.toContain('"backend":');
  });

  it("overrides a service's environment variables when the manifest gives them", () => {
    const text = renderOverride(
      stack({
        name: "webapp",
        serviceEnv: {
          backend: { ENVIRONMENT: "development", ENABLED_FEATURES: "a,b" },
        },
      }),
      { name: "webapp-main", services: { frontend: {}, backend: {} } },
      "main",
    );
    expect(text).toContain(
      '"backend":\n    environment:\n      "ENABLED_FEATURES": "a,b"\n      "ENVIRONMENT": "development"',
    );
    expect(text).not.toContain('"frontend":');
  });

  it("refuses service_env for a service the compose project lacks", () => {
    expect(() =>
      renderOverride(
        stack({ name: "webapp", serviceEnv: { bakend: { X: "1" } } }),
        { name: "webapp-main", services: { backend: {} } },
        "main",
      ),
    ).toThrow(/service_env names "bakend"/);
  });

  it("resets every published port and keeps base networks when linking", () => {
    const text = renderOverride(webapp, resolved, "main");
    expect(text).toContain('"frontend":\n    ports: !reset []');
    expect(text).toContain('"backend":\n    ports: !reset []');
    expect(text).not.toContain('"postgres":\n    ports');
    expect(text).toContain('"ai-expert-network": {}');
    expect(text).toContain('"webapp-main--ragstack": {}');
    expect(text).toContain(
      'networks:\n  "webapp-main--ragstack":\n    name: "webapp-main--ragstack"\n    external: true',
    );
  });

  it("links only the services that refer to the provider", () => {
    expect(linkedServices(webapp, "ragstack", resolved, "main")).toEqual([
      "frontend",
    ]);
    const text = renderOverride(webapp, resolved, "main");
    const block = (svc: string) =>
      text.slice(text.indexOf(`"${svc}":`)).split('\n  "')[0];
    expect(block("frontend")).toContain('"webapp-main--ragstack": {}');
    expect(block("backend")).not.toContain("webapp-main--ragstack");
    expect(text).not.toContain('"postgres":');
  });

  it("renders a valid empty override when nothing needs changing", () => {
    const text = renderOverride(
      stack({ name: "x" }),
      { name: "x-main", services: { a: {} } },
      "main",
    );
    expect(yaml.parse(text)).toEqual({ services: {} });
  });

  it("joins the edge to the routed services' real networks", () => {
    expect(routedNetworks(webapp, resolved)).toEqual([
      "webapp-main_ai-expert-network",
    ]);
    const def: ResolvedProject = {
      name: "h-main",
      services: { "ragstack-server": {} },
    };
    expect(routedNetworks(ragstack, def)).toEqual(["h-main_default"]);
    expect(() =>
      routedNetworks(stack({ routes: { x: "ghost:1" } }), def),
    ).toThrow(/not in compose/);
  });

  it("routes <route>.<stack> on every edge domain to the container", () => {
    const doc = yaml.parse(renderStackRoutes(edge, webapp, resolved));
    const r = doc.http.routers["stack-webapp-app"];
    expect(r.rule).toBe(
      "Host(`app.webapp.globex.localhost`) || Host(`app.webapp.globex.internal`)",
    );
    expect(
      doc.http.services["stack-webapp-api"].loadBalancer.servers[0].url,
    ).toBe("http://webapp-main-backend-1:3001");
  });
});
