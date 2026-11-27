import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import type * as http from "http";
import * as os from "os";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { resetHelperCache } from "../../../src/shared/agents/claude-helpers.js";
import { helpersBlock } from "../../../src/shared/den-config.js";
import { rowHelpers } from "../../../src/ui/cli/agent-ops.js";
import { HelperRows } from "../../../src/ui/server/helper-rows.js";
import { handleSessionList } from "../../../src/ui/server/session-routes.js";
import { writeHelper } from "../agents/helpers/seed-helpers.js";

const AGENTS = 40;
const SPIN_MS = 25;
const HOPS = 30;
let dir = "";
let stateDir = "";
let home = "";
const savedHome = process.env.HOME;
const token = (i: number) =>
  `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function seed(from: number, to: number) {
  for (let i = from; i < to; i++) {
    writeHelper(home, token(i), `a${String(i).padStart(16, "0")}`, "Look");
    writeRecord(stateDir, {
      id: `agent${i}`,
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      cwd: dir,
      session: { backend: "den-pty", id: `gone-${i}` },
      sessionName: `acme-north:agent${i}`,
      startedAt: "2026-11-01T09:59:00.000Z",
      resumeToken: token(i),
    } as Parameters<typeof writeRecord>[1]);
  }
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1861-")));
  stateDir = path.join(dir, "state");
  home = path.join(dir, "home");
  process.env.HOME = home;
  seed(0, AGENTS);
});

afterEach(() => {
  process.env.HOME = savedHome;
  resetHelperCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

function list(rows: HelperRows, compute: typeof rowHelpers) {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead() {},
    end(b?: string) {
      body = b ?? "";
    },
  } as unknown as http.ServerResponse;
  const req = { method: "GET", url: "/api/sessions" } as http.IncomingMessage;
  return handleSessionList(req, res, "/api/sessions", true, {
    stateDir: () => stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
    connectExisting: async () => null,
    hubNow: async () => null,
    helperSettings: () => helpersBlock({ refresh_seconds: 30 }),
    helperRows: rows,
    rowHelpers: compute,
  }).then(
    () =>
      JSON.parse(body) as {
        sessions: { agent?: string; helpers?: { total: number } }[];
      },
  );
}

function slow(): typeof rowHelpers {
  return (rec, ...rest) => {
    const end = Date.now() + SPIN_MS;
    let spins = 0;
    while (Date.now() < end) spins++;
    expect(spins).toBeGreaterThanOrEqual(0);
    return rowHelpers(rec, ...rest);
  };
}

async function hops(file: string): Promise<number> {
  const t0 = Date.now();
  for (let i = 0; i < HOPS; i++) await fs.promises.stat(file);
  return Date.now() - t0;
}

const counted = (j: Awaited<ReturnType<typeof list>>) =>
  j.sessions.filter((s) => s.agent && s.helpers).length;

describe("issue 1861: the first list over many unread agents never waits for all of them", () => {
  it("answers well before every helper row is read, and the reader fills in the rest", async () => {
    const rows = new HelperRows();
    const t0 = Date.now();
    const first = await list(rows, slow());
    const took = Date.now() - t0;
    expect(took).toBeLessThan((AGENTS * SPIN_MS) / 2);
    expect(first.sessions.filter((s) => s.agent)).toHaveLength(AGENTS);
    await rows.idle();
    expect(counted(await list(rows, slow()))).toBe(AGENTS);
  });

  it("another request's async steps aren't held one helper row each while the reader works", async () => {
    const rows = new HelperRows();
    const file = path.join(dir, "probe");
    fs.writeFileSync(file, "x");
    const idle = await hops(file);
    const listing = list(rows, slow());
    const during = await hops(file);
    await listing;
    await rows.idle();
    expect(during).toBeLessThan(Math.max(150, 10 * idle));
  });

  it("a wave of new records on a warm server doesn't hold the next list", async () => {
    const rows = new HelperRows();
    await list(rows, slow());
    await rows.idle();
    seed(AGENTS, AGENTS + 8);
    const t0 = Date.now();
    const next = await list(rows, slow());
    expect(Date.now() - t0).toBeLessThan(8 * SPIN_MS);
    expect(next.sessions.filter((s) => s.agent)).toHaveLength(AGENTS + 8);
    await rows.idle();
  });
});
