/**
 * Issue 943: the fixture person (the test person a test install's live
 * checks sign in as, issue 810) may send a message from the page to the
 * test bed's own stub agents, so a live check of that path can run.
 *
 *  - Only on a test install: anywhere else the say is refused.
 *  - Only to an agent Den marked `testBed` when it started it on the
 *    test-person path (issue 636). An agent started any other way, and
 *    Den's own server agent, are refused.
 *  - The mark is Den's own: no write the fixture person can make sets it,
 *    and a start off the path clears it.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { readRecord } from "../../../src/shared/agents/records.js";
import { useTestPerson } from "../../../src/shared/test-person.js";
import { fixtureScopeRefusal } from "../../../src/shared/fixture-person.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  fixtureMaySay,
  handleAgentRoutes,
} from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  useTestPerson(false);
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

/** Each scripted session ends on TERM, so a stop finishes (as for real). */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** Starts `id` in north; on the test-person path when `bed`. */
async function start(r: Rig, id: string, bed: boolean): Promise<void> {
  useTestPerson(bed);
  try {
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--name",
        id,
        "--id",
        id,
      ),
    ).toBe(0);
  } finally {
    useTestPerson(false);
  }
}

/** The agent routes, as the fixture person's signed-in browser. */
async function asFixture(r: Rig, testInstall: boolean): Promise<string> {
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    setPrincipal(req, { kind: "person-browser", session: "fx", fixture: true });
    void handleAgentRoutes(req, res, p, {
      agents: r.deps,
      testInstall: () => testInstall,
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end("{}");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(base: string, path: string, body: unknown) {
  const r = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    json: (await r.json()) as Record<string, unknown>,
  };
}

const say = (base: string, id: string) =>
  post(base, `/api/workspaces/north/agents/${id}/say`, { text: "gate probe" });

describe("issue 943: Den marks the bed's own agents", () => {
  it("an agent started on the test-person path is marked testBed", async () => {
    const r = await rig();
    await start(r, "stub-a", true);
    expect(readRecord(r.stateDir, "stub-a")!.testBed).toBe(true);
  });

  it("a resume keeps the mark (the same agent)", async () => {
    const r = await rig();
    endOnTerm(r);
    await start(r, "stub-r", true);
    expect(await agents(r, "stop", "stub-r", "-w", "north")).toBe(0);
    expect(await agents(r, "resume", "stub-r", "-w", "north")).toBe(0);
    expect(readRecord(r.stateDir, "stub-r")!.testBed).toBe(true);
  });

  it("an agent started any other way is not", async () => {
    const r = await rig();
    await start(r, "real-a", false);
    expect(readRecord(r.stateDir, "real-a")!.testBed).toBeUndefined();
  });
});

describe("issue 943: the fixture person's message from the page", () => {
  it("reaches a marked agent on a test install (not refused as a person-only write)", async () => {
    const r = await rig();
    await start(r, "stub-b", true);
    const res = await say(await asFixture(r, true), "stub-b");
    expect(res.status).not.toBe(403);
  });

  it("is refused (403) to an agent Den didn't mark, even on a test install", async () => {
    const r = await rig();
    await start(r, "real-b", false);
    const res = await say(await asFixture(r, true), "real-b");
    expect(res.status).toBe(403);
    expect(String(res.json.error)).toMatch(/only a person can send/);
  });

  it("is refused (403) on an install that isn't a test install, even to a marked agent", async () => {
    const r = await rig();
    await start(r, "stub-c", true);
    const res = await say(await asFixture(r, false), "stub-c");
    expect(res.status).toBe(403);
  });

  it("never reaches Den's own server agent, marked or not", () => {
    const rec = { testBed: true as const };
    expect(fixtureMaySay(rec, "den-server", true)).toBe(false);
    expect(fixtureMaySay(rec, "north", true)).toBe(true);
    expect(fixtureMaySay(rec, "north", false)).toBe(false);
    expect(fixtureMaySay({}, "north", true)).toBe(false);
  });
});

describe("issue 943: the mark is Den's own", () => {
  it("the fixture person's writes to an agent can't set it", async () => {
    const r = await rig();
    await start(r, "real-d", false);
    const base = await asFixture(r, true);
    for (const verb of ["settings", "name", "link", "mode", "persona"]) {
      await post(base, `/api/workspaces/north/agents/real-d/${verb}`, {
        testBed: true,
        name: "x",
      });
      expect(readRecord(r.stateDir, "real-d")!.testBed).toBeUndefined();
    }
  });

  it("the fixture person's allow-list has say, and no other agent write that edits a record", () => {
    const at = (v: string) => `/api/workspaces/north/agents/a1/${v}`;
    expect(fixtureScopeRefusal("POST", at("say"), "mutating")).toBeNull();
    for (const v of [
      "settings",
      "name",
      "link",
      "mode",
      "persona",
      "move",
      "order",
      "keep",
    ])
      expect(fixtureScopeRefusal("POST", at(v), "mutating")).toMatch(
        /fixture person/,
      );
  });

  it("a start off the test-person path clears it", async () => {
    const r = await rig();
    endOnTerm(r);
    await start(r, "stub-e", true);
    expect(readRecord(r.stateDir, "stub-e")!.testBed).toBe(true);
    expect(await agents(r, "stop", "stub-e", "-w", "north")).toBe(0);
    await start(r, "stub-e", false);
    expect(readRecord(r.stateDir, "stub-e")!.testBed).toBeUndefined();
  });
});
