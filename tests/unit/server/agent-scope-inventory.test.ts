/**
 * Every route an agent's token reaches keeps to its project scope, in
 * both install modes (agent-scope-routes.ts). For each route in
 * route-classes.ts and each method:
 *  - refused to an agent in its own project too: a person's; nothing more;
 *  - naming a project in its path (`:ws`, `:project`): another project is
 *    refused, a write on every install, a read on a strict one;
 *  - else listed in AGENT_SCOPE_ROUTES, and a write is never "open".
 * A new route an agent reaches that is in none of these fails here.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import type { InstallMode } from "../../../src/shared/den-config.js";
import { AGENT_SCOPE_ROUTES } from "../../../src/ui/server/agent-scope-routes.js";
import {
  agentRefusal,
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
/** A path for the route, its project segment `ws`. */
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

describe.each(["personal", "strict"] as InstallMode[])(
  "%s install: every route an agent reaches keeps to its scope",
  (mode) => {
    const why = (m: string, p: string, cls: string) =>
      agentRefusal(north, m, p, cls as never, undefined, () => mode);

    it("a route naming a project in its path refuses another project", () => {
      const leaks = pairs
        .filter(({ r }) => r.path.split("/").some((s) => PROJECT.test(s)))
        .filter(({ m, r }) => why(m, sample(r.path, "north"), r.cls) === null)
        .filter(({ m, r }) => mode === "strict" || !isRead(m, r.cls))
        .filter(({ m, r }) => why(m, sample(r.path, "south"), r.cls) === null)
        .map(({ key }) => key);
      expect(leaks).toEqual([]);
    });

    it("every other route an agent reaches is in AGENT_SCOPE_ROUTES", () => {
      const missing = pairs
        .filter(({ r }) => !r.path.split("/").some((s) => PROJECT.test(s)))
        .filter(({ m, r }) => why(m, sample(r.path, "north"), r.cls) === null)
        .map(({ key }) => key)
        .filter((k) => !(k in AGENT_SCOPE_ROUTES));
      expect(missing).toEqual([]);
    });
  },
);

describe("AGENT_SCOPE_ROUTES", () => {
  it("lists only routes the table has, an agent reaches, and no write as open", () => {
    const known = new Set(pairs.map((p) => p.key));
    const cls = new Map(pairs.map((p) => [p.key, p.r.cls]));
    const bad = Object.entries(AGENT_SCOPE_ROUTES).flatMap(([k, v]) => {
      const out: string[] = [];
      if (!known.has(k)) out.push(`${k}: not in route-classes.ts`);
      const [m, p] = k.split(" ");
      if (
        known.has(k) &&
        agentRefusal(north, m!, sample(p!, "north"), cls.get(k)!) !== null
      )
        out.push(`${k}: a person's already (take it out)`);
      if (v.kind === "open" && m !== "GET") out.push(`${k}: a write, open`);
      if (!v.why.trim()) out.push(`${k}: no why`);
      return out;
    });
    expect(bad).toEqual([]);
  });
});
