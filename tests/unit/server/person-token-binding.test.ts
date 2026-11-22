/**
 * The person's token counts only from outside every agent's processes.
 * A process an agent started (whatever its environment says) that sends
 * the person's token over loopback is refused (403) before any route
 * runs; so is one Den can't place. Shells on the Terminals page and the
 * test bed's test-person path keep working. Invented names; fake pids.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import {
  agentPeerWait,
  personTokenPlace,
} from "../../../src/ui/server/token-binding.js";
import {
  agentSessionIds,
  agentSessionRoots,
} from "../../../src/shared/person-here.js";
import { agentsDir } from "../../../src/shared/agents/records.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

const PORT = 41237;
const ctx = (
  place: "ok" | "in_agent" | "unknown" | undefined,
  testBed = false,
): GuardContext => ({
  port: PORT,
  loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
  edgeHosts: () => [],
  verifyBearer: (t) => (t === "den_pt_good" ? "person:someone" : null),
  testBed: () => testBed,
  ...(place ? { personTokenFrom: () => place } : {}),
});
const req = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
): http.IncomingMessage =>
  ({
    method,
    url,
    headers: {
      host: `localhost:${PORT}`,
      authorization: "Bearer den_pt_good",
      ...headers,
    },
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as http.IncomingMessage;
const MODE = "/api/workspaces/north/agents/stub/mode";

describe("the person's token from an agent's processes", () => {
  it("is refused before any route runs", () => {
    const r = checkRequest(req("POST", MODE), ctx("in_agent"));
    expect(r).toMatchObject({
      ok: false,
      status: 403,
      code: "person_token_in_agent",
    });
    if (!r.ok) expect(r.error).toMatch(/Nothing ran/);
  });

  it("from a process Den can't place: refused too", () => {
    expect(
      checkRequest(req("GET", "/api/settings"), ctx("unknown")),
    ).toMatchObject({ ok: false, status: 403, code: "person_token_unplaced" });
  });

  it("from the person's own terminal: as before", () => {
    expect(checkRequest(req("POST", MODE), ctx("ok")).ok).toBe(true);
  });

  it("the test bed's test-person path still works", () => {
    const r = checkRequest(
      req("POST", MODE, { "x-den-test-person": "1" }),
      ctx("in_agent", true),
    );
    expect(r.ok).toBe(true);
  });
});

describe("placing the caller", () => {
  it("a line through an agent's session root is the agent's", () => {
    const o = { loopback: true, edgeProved: false, roots: [500] };
    expect(personTokenPlace({ ...o, line: [900, 500, 1] })).toBe("in_agent");
    expect(personTokenPlace({ ...o, line: [900, 400, 1] })).toBe("ok");
    expect(personTokenPlace({ ...o, line: null })).toBe("unknown");
    expect(personTokenPlace({ ...o, line: [900, 1], roots: null })).toBe(
      "unknown",
    );
  });

  it("headers that only look forwarded don't skip it; only the edge's proof does", () => {
    const o = { loopback: true, roots: [500], line: [900, 500, 1] };
    // X-Forwarded-For, or an edge Host, with no proof: still placed.
    expect(personTokenPlace({ ...o, edgeProved: false })).toBe("in_agent");
    expect(personTokenPlace({ ...o, edgeProved: true })).toBe("ok");
    expect(personTokenPlace({ ...o, loopback: false, edgeProved: false })).toBe(
      "ok",
    );
  });

  it("the person's token waits for its caller to be placed, binding or not", () => {
    const r = (auth: string) =>
      ({ headers: { authorization: auth } }) as unknown as http.IncomingMessage;
    expect(agentPeerWait(r("Bearer den_pt_x"), { on: false, waitMs: 77 })).toBe(
      77,
    );
    expect(agentPeerWait(r("Bearer den_pt_x"), { on: true, waitMs: 77 })).toBe(
      77,
    );
    // Not a person's token (garbage, a runner's): no wait.
    expect(agentPeerWait(r("Bearer junk"), { on: true, waitMs: 77 })).toBe(
      null,
    );
  });
});

describe("agent session roots", () => {
  let dir = "";
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it("lists running agents' roots only (not Terminals shells, not ended)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-roots-"));
    const d = sessionPaths(dir).dir;
    fs.mkdirSync(d, { recursive: true });
    const put = (id: string, v: object) =>
      fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify(v));
    put("s-agent", { pid: 501 });
    put("s-shell", { pid: 502 });
    put("s-ended", { pid: 503, exited: true });
    expect(agentSessionRoots(dir, ["s-agent", "s-ended", "s-gone"])).toEqual([
      501,
    ]);
  });
});

describe("agent session ids", () => {
  let dir = "";
  afterEach(() => {
    if (!dir) return;
    try {
      fs.chmodSync(agentsDir(dir), 0o700);
    } catch {
      /* gone */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no agents folder yet: none; one Den can't read, or a corrupt record: unknown", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ids-"));
    expect(agentSessionIds(dir)).toEqual([]);
    const a = agentsDir(dir);
    fs.mkdirSync(a, { recursive: true });
    fs.writeFileSync(
      path.join(a, "be.json"),
      JSON.stringify({ id: "be", session: { id: "s-1", name: "be" } }),
    );
    expect(agentSessionIds(dir)).toEqual(["s-1"]);
    fs.writeFileSync(path.join(a, "bad.json"), "{not json");
    expect(agentSessionIds(dir)).toBeNull();
    fs.rmSync(path.join(a, "bad.json"));
    fs.chmodSync(a, 0o000);
    expect(agentSessionIds(dir)).toBeNull();
  });
});
