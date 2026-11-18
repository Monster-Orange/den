/**
 * #176: the new Den's doctor results, from Den's update of itself, reach
 * the server agent through release_status (read only). den-update.ts keeps
 * them beside the update's state (<state>/server-agent/update/doctor.json),
 * GET /api/server-agent/update reads both, and release_status shows them
 * to the whole Den's callers (never a project's agent). Den's line when it
 * is back says them itself (#384): the agent's tools predate the update.
 *
 * Every command is faked (no npm, no Den CLI, no restart); the API is a
 * fake that records what was asked.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  lastUpdate,
  updateDen,
  updateStateFile,
  type Ran,
  type UpdateDeps,
} from "../../../src/ui/server/den-update.js";
import {
  backMessage,
  type RestartMarker,
} from "../../../src/ui/server/server-restart.js";
import { runOneShot } from "../../../src/ui/mcp/server.js";
import { DenHttpError, type DenApi } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";

const NAME = "@example/den";
let tmp: string;
let root: string;
let engine: string;
let stateDir: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-176-"));
  root = path.join(tmp, "dist");
  engine = path.join(root, "node_modules", "@example", "den");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(path.join(engine, "src/ui/server"), { recursive: true });
  fs.writeFileSync(
    path.join(engine, "src/ui/server/update-watch.mjs"),
    "// the watch\n",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ dependencies: { [NAME]: "1.0.0" } }),
  );
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"lock":"1.0.0"}');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DOCTOR = JSON.stringify({
  checks: [
    { id: "edge", status: "ok", detail: "fine" },
    { id: "hub", status: "warn", detail: "not connected" },
    { id: "pin", status: "fail", detail: "package.json has no pin" },
  ],
});

function deps(
  version: string,
  answers: (argv: string[]) => Ran = () => ({ code: 0, out: DOCTOR }),
): UpdateDeps {
  return {
    root,
    engine,
    stateDir,
    pkg: { name: NAME, version },
    npmView: async (spec) => (spec.endsWith("@latest") ? "1.1.0" : "1.2.0"),
    npm: ["npm"],
    cli: ["den"],
    run: async (argv) => answers(argv),
    watch: () => 4242,
    note: (reason) => ({
      path: path.join(stateDir, "restart.json"),
      marker: { reason },
    }),
    restart: () => undefined,
    port: 7000,
    pid: 1111,
    waitMs: 180_000,
    now: () => Date.parse("2026-11-17T12:00:00.000Z"),
  };
}

/** What the watch writes once it has judged the new version. */
function watchSays(state: string, from: string, to: string, why?: string) {
  fs.writeFileSync(
    updateStateFile(stateDir),
    JSON.stringify({
      state,
      from,
      to,
      at: "2026-11-17T12:03:00.000Z",
      ...(why ? { why } : {}),
    }),
  );
}

describe("#176: the update keeps the new Den's doctor results", () => {
  it("beside its state, through the watch's verdict", async () => {
    expect(lastUpdate(stateDir)).toBeNull();
    const res = await updateDen("latest", deps("1.0.0"));
    expect(res).toMatchObject({
      ok: true,
      doctor: [
        "warn: hub: not connected",
        "fail: pin: package.json has no pin",
      ],
    });
    const doctor = {
      at: "2026-11-17T12:00:00.000Z",
      lines: ["warn: hub: not connected", "fail: pin: package.json has no pin"],
    };
    expect(lastUpdate(stateDir)).toMatchObject({
      state: "watching",
      from: "1.0.0",
      to: "1.1.0",
      doctor,
    });
    // The watch (the old version's) writes its verdict without them.
    watchSays("good", "1.0.0", "1.1.0");
    expect(lastUpdate(stateDir)).toEqual({
      state: "good",
      from: "1.0.0",
      to: "1.1.0",
      at: "2026-11-17T12:03:00.000Z",
      doctor,
    });
    // Rolled back by the watch: the doctor results of the version that
    // didn't take stay, with why.
    watchSays("rolled_back", "1.0.0", "1.1.0", "Den 1.1.0 never answered");
    expect(lastUpdate(stateDir)).toMatchObject({
      state: "rolled_back",
      why: "Den 1.1.0 never answered",
      doctor,
    });
  });

  it("a later update clears them; one rolled back before doctor ran has none", async () => {
    await updateDen("latest", deps("1.0.0"));
    watchSays("good", "1.0.0", "1.1.0");
    const res = await updateDen(
      "1.2.0",
      deps("1.1.0", (argv) =>
        argv.includes("--save-exact")
          ? { code: 1, out: "ETARGET" }
          : { code: 0, out: "" },
      ),
    );
    expect(res.ok).toBe(false);
    const last = lastUpdate(stateDir);
    expect(last).toMatchObject({
      state: "rolled_back",
      from: "1.1.0",
      to: "1.2.0",
    });
    expect(last).not.toHaveProperty("doctor");
  });
});

const ID = "AbCdEfGhIjKlMnOp";
const UPDATE = {
  state: "good",
  from: "1.0.0",
  to: "1.1.0",
  at: "2026-11-17T12:03:00.000Z",
  doctor: {
    at: "2026-11-17T12:00:00.000Z",
    lines: ["warn: hub: not connected"],
  },
};

function fakeApi(updateRoute: "ok" | "404" = "ok") {
  const calls: string[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(p) {
      calls.push(p);
      if (p === "/api/release/runs") return { runs: [] };
      if (p === "/api/server-agent/update") {
        if (updateRoute === "404")
          throw new DenHttpError("GET", p, 404, "not found");
        return { update: UPDATE };
      }
      if (p === "/api/server-info") return { version: "0.4.63" };
      if (p === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      if (p === "/api/activity") return { ok: true };
      if (p === `/api/approvals/${ID}`) return { id: ID, state: "pending" };
      throw new DenHttpError("GET", p, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}

const cfg = (): ResolvedMcpConfig => ({
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

async function releaseStatus(
  scope?: { workspace: string; actor: string },
  updateRoute: "ok" | "404" = "ok",
) {
  const { api, calls } = fakeApi(updateRoute);
  let out = "";
  let err = "";
  const code = await runOneShot(
    { kind: "call", tool: "release_status", args: {} },
    {
      cfg: cfg(),
      cli: "acme",
      api,
      ...(scope ? { scope } : {}),
      out: (t) => (out += t),
      err: (t) => (err += t),
    },
  );
  return { code, out, err, calls };
}

describe("#176: release_status shows Den's last update and its doctor", () => {
  it("to the server agent: from, to, when, and the new Den's doctor lines", async () => {
    const s = await releaseStatus({
      workspace: SERVER_SCOPE,
      actor: "agent:server",
    });
    expect([s.code, s.err]).toEqual([0, ""]);
    const j = JSON.parse(s.out);
    expect(j.runs).toEqual({ runs: [] });
    expect(j.denUpdate).toEqual(UPDATE);
  });

  it("a project's agent gets the releases only", async () => {
    const s = await releaseStatus({ workspace: "north", actor: "agent:x" });
    expect([s.code, s.err]).toEqual([0, ""]);
    expect(JSON.parse(s.out)).not.toHaveProperty("denUpdate");
    expect(s.calls).not.toContain("/api/server-agent/update");
  });

  it("a web server older than the route still answers the releases, and says why there's no update", async () => {
    const s = await releaseStatus(
      { workspace: SERVER_SCOPE, actor: "agent:server" },
      "404",
    );
    expect(s.code).toBe(0);
    const j = JSON.parse(s.out);
    expect(j.runs).toEqual({ runs: [] });
    expect(j.denUpdate).toMatchObject({
      unknown: expect.stringMatching(/restart/),
    });
  });
});

describe("#384: Den's line when it is back says the doctor results itself", () => {
  const marker = (over: Partial<RestartMarker> = {}): RestartMarker => ({
    id: "",
    reason: "update Den 0.4.41 → 0.4.42",
    agent: "server",
    by: "den",
    fromVersion: "0.4.41",
    fromPid: 111,
    at: "2026-11-17T12:00:00.000Z",
    ...over,
  });
  const update = (lines: string[] | null) => ({
    state: "good" as const,
    from: "0.4.41",
    to: "0.4.42",
    at: "2026-11-17T12:00:05.000Z",
    ...(lines ? { doctor: { at: "2026-11-17T12:00:03.000Z", lines } } : {}),
  });

  it("updated: the doctor lines, on one line, and no tool sent to for them", () => {
    const t = backMessage(
      marker(),
      "0.4.42",
      222,
      update(["warn hub: not\nconnected", "fail pin: no pin"]),
    );
    expect(t).toContain(
      "The new Den's doctor found: warn hub: not connected; fail pin: no pin.",
    );
    expect(t).not.toMatch(/\n/);
    expect(t).not.toMatch(/release_status|with doctor/);
    expect(t).toMatch(/restarts you from Den/);
  });

  it("updated, doctor clean or not kept, and a long list cut short", () => {
    expect(backMessage(marker(), "0.4.42", 222, update([]))).toContain(
      "The new Den's doctor found nothing failing or warning.",
    );
    expect(backMessage(marker(), "0.4.42", 222, update(null))).toContain(
      "No doctor results were kept for this update.",
    );
    expect(backMessage(marker(), "0.4.42", 222, null)).toContain(
      "No doctor results were kept for this update.",
    );
    const many = Array.from({ length: 11 }, (_, i) => `warn c${i}: x`);
    const t = backMessage(marker(), "0.4.42", 222, update(many));
    expect(t).toContain("warn c7: x; and 3 more.");
    expect(t).not.toContain("warn c8");
  });

  it("an older update's results are not this one's", () => {
    const old = { ...update(["warn old: x"]), from: "0.4.39", to: "0.4.40" };
    const t = backMessage(marker(), "0.4.42", 222, old);
    expect(t).not.toContain("warn old");
    expect(t).toContain("No doctor results were kept for this update.");
  });

  it("rolled back: why, and what doctor found; the agent's own update too", () => {
    const rolled = {
      ...update(["fail edge: down"]),
      state: "rolled_back" as const,
    };
    const den = backMessage(
      marker({ rolledBack: true, fromVersion: "0.4.42" }),
      "0.4.41",
      222,
      rolled,
    );
    expect(den).toContain("The new Den's doctor found: fail edge: down.");
    expect(den).not.toMatch(/release_status|restarts you from Den/);
    const asked = backMessage(
      marker({ by: undefined, rolledBack: true, fromVersion: "0.4.42" }),
      "0.4.41",
      222,
      rolled,
    );
    expect(asked).toContain("fail edge: down");
    const good = backMessage(
      marker({ by: undefined }),
      "0.4.42",
      222,
      update(["warn hub: x"]),
    );
    expect(good).toMatch(
      /You restarted it: update Den 0\.4\.41 → 0\.4\.42\. The new Den's doctor found: warn hub: x\. Your Den tools .* Carry on from where you were\.$/,
    );
  });

  it("a plain restart (no update) says nothing of doctor", () => {
    const t = backMessage(
      marker({ by: undefined, reason: "new pin" }),
      "0.4.41",
      222,
      update(["warn hub: x"]),
    );
    expect(t).toBe(
      "Server is back on 0.4.41 (pid 222). You restarted it: new pin. Carry on from where you were.",
    );
  });
});
