import { describe, expect, it } from "@jest/globals";
import type { InstallMode } from "../../../src/shared/den-config.js";
import { AGENT_SCOPE_ROUTES } from "../../../src/ui/server/agent-scope-routes.js";
import {
  agentRefusal,
  STRICT_PERSON_READS,
  type AgentPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";

const north: AgentPrincipal = {
  kind: "agent",
  actor: "agent:a1",
  workspace: "north",
  grants: [],
  session: { name: "acme-den:north:a1" },
};

const PROJECT = /^:(ws|project)$/;
const sample = (path: string, ws: string) =>
  path
    .split("/")
    .map((s) => (PROJECT.test(s) ? ws : s.startsWith(":") ? "x1" : s))
    .join("/")
    .replace(/\*$/, "x1");

const pairs = ROUTES.flatMap((r) =>
  r.methods
    .filter((m) => m !== "HEAD")
    .map((m) => ({ m, r, key: `${m} ${r.path}` })),
).filter(({ r }) => r.path.startsWith("/api/"));

const isRead = (m: string, cls: string) => m === "GET" && cls === "readonly";

const SAMPLE_QUERY: Record<string, string> = {
  "/api/service/exec": "cmd=restart&env=local",
};
const queryOf = (path: string) => new URLSearchParams(SAMPLE_QUERY[path] ?? "");

const INERT = ["POST /api/manifest/validate", "POST /api/report/preview"];

describe.each(["personal", "strict"] as InstallMode[])(
  "%s install: every route an agent reaches keeps to its scope",
  (mode) => {
    const why = (m: string, path: string, ws: string, cls: string) =>
      agentRefusal(
        north,
        m,
        sample(path, ws),
        cls as never,
        queryOf(path),
        () => mode,
      );

    it("a route naming a project in its path refuses another project", () => {
      const leaks = pairs
        .filter(({ r }) => r.path.split("/").some((s) => PROJECT.test(s)))
        .filter(({ m, r }) => why(m, r.path, "north", r.cls) === null)
        .filter(({ m, r }) => mode === "strict" || !isRead(m, r.cls))
        .filter(({ m, r }) => why(m, r.path, "south", r.cls) === null)
        .map(({ key }) => key);
      expect(leaks).toEqual([]);
    });

    it("every other route an agent reaches is in AGENT_SCOPE_ROUTES", () => {
      const missing = pairs
        .filter(({ r }) => !r.path.split("/").some((s) => PROJECT.test(s)))
        .filter(({ m, r }) => why(m, r.path, "north", r.cls) === null)
        .map(({ key }) => key)
        .filter((k) => !(k in AGENT_SCOPE_ROUTES));
      expect(missing).toEqual([]);
    });
  },
);

describe("AGENT_SCOPE_ROUTES", () => {
  it("lists only routes the table has, an agent reaches, and every write held", () => {
    const known = new Set(pairs.map((p) => p.key));
    const cls = new Map(pairs.map((p) => [p.key, p.r.cls]));
    const bad = Object.entries(AGENT_SCOPE_ROUTES).flatMap(([k, v]) => {
      const out: string[] = [];
      if (!known.has(k)) out.push(`${k}: not in route-classes.ts`);
      const [m, p] = k.split(" ");
      if (
        known.has(k) &&
        agentRefusal(
          north,
          m!,
          sample(p!, "north"),
          cls.get(k)!,
          queryOf(p!),
          () => "personal",
        ) !== null
      )
        out.push(`${k}: a person's already (take it out)`);
      const writes = known.has(k) && cls.get(k) !== "readonly";
      if (writes && !["handler", "own", "inert"].includes(v.kind))
        out.push(`${k}: ${cls.get(k)}, but ${v.kind}`);
      if (v.kind === "inert" && !INERT.includes(k))
        out.push(`${k}: inert, but not on the hand-checked list`);
      const strictOnly = STRICT_PERSON_READS.includes(p!);
      if ((v.kind === "person-strict") !== (strictOnly && m === "GET"))
        out.push(`${k}: person-strict and STRICT_PERSON_READS disagree`);
      if (!v.why.trim()) out.push(`${k}: no why`);
      return out;
    });
    expect(bad).toEqual([]);
  });
});

describe("STRICT_PERSON_READS", () => {
  it("each is a GET route, refused to a project agent on strict, served to the server agent", () => {
    const server: AgentPrincipal = { ...north, workspace: "den-server" };
    const bad = STRICT_PERSON_READS.flatMap((path) => {
      const r = ROUTES.find((x) => x.path === path);
      if (!r?.methods.includes("GET")) return [`${path}: no GET route`];
      const at = sample(path, "north");
      const out: string[] = [];
      if (
        agentRefusal(north, "GET", at, r.cls, undefined, () => "strict") ===
        null
      )
        out.push(`${path}: served on strict`);
      if (
        agentRefusal(north, "GET", at, r.cls, undefined, () => "personal") !==
        null
      )
        out.push(`${path}: refused on personal`);
      if (
        agentRefusal(server, "GET", at, r.cls, undefined, () => "strict") !==
        null
      )
        out.push(`${path}: refused to the server agent`);
      return out;
    });
    expect(bad).toEqual([]);
  });
});
