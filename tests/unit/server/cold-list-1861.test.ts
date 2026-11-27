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

function list(
  rows: HelperRows,
  compute: typeof rowHelpers,
  extra: Record<string, unknown> = {},
) {
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
    helperSettings: () => helpersBlock({ refresh_seconds: 30, ...extra }),
    helperRows: rows,
    rowHelpers: compute,
  }).then(
    () =>
      JSON.parse(body) as {
        helpersPending?: boolean;
        sessions: {
          agent?: string;
          helpers?: { total: number };
          helpersPending?: boolean;
        }[];
      },
  );
}

function slow(spinMs = SPIN_MS): typeof rowHelpers {
  return (rec, ...rest) => {
    const end = Date.now() + spinMs;
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

describe("issue 1861: agents.helpers.list_wait_seconds and reader_rest_ms", () => {
  it("default to 0.25 s and 2 ms; a value is read; a bad one names the key", () => {
    const d = helpersBlock({});
    expect([d.listWaitSeconds, d.readerRestMs]).toEqual([0.25, 2]);
    const v = helpersBlock({ list_wait_seconds: 0, reader_rest_ms: 0 });
    expect([v.listWaitSeconds, v.readerRestMs]).toEqual([0, 0]);
    expect(() => helpersBlock({ list_wait_seconds: 61 })).toThrow(
      "agents.helpers.list_wait_seconds",
    );
    expect(() => helpersBlock({ reader_rest_ms: -1 })).toThrow(
      "agents.helpers.reader_rest_ms",
    );
  });
});

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

  it("rows not read yet say so, the list says so, and the next list has them", async () => {
    const rows = new HelperRows();
    const first = await list(rows, slow());
    const waiting = first.sessions.filter((s) => s.helpersPending);
    expect(first.helpersPending).toBe(true);
    expect(waiting.length).toBeGreaterThan(0);
    for (const s of waiting) expect(s.helpers).toBeUndefined();
    await rows.idle();
    const next = await list(rows, slow());
    expect(next.helpersPending).toBeUndefined();
    expect(next.sessions.filter((s) => s.helpersPending)).toEqual([]);
    expect(counted(next)).toBe(AGENTS);
  });

  it("the rest between rows adds little to the time to read them all", async () => {
    const fill = async (extra: Record<string, unknown>) => {
      resetHelperCache();
      const rows = new HelperRows();
      const t0 = Date.now();
      await list(rows, slow(), extra);
      await rows.idle();
      return Date.now() - t0;
    };
    const none = await fill({ reader_rest_ms: 0 });
    const rested = await fill({});
    expect(none).toBeGreaterThanOrEqual(AGENTS * SPIN_MS);
    expect(rested).toBeLessThan(none * 1.3);
  });

  it("a wave of new records on a warm server doesn't hold the next list", async () => {
    const rows = new HelperRows();
    await list(rows, slow());
    await rows.idle();
    seed(AGENTS, AGENTS + 8);
    const t0 = Date.now();
    const next = await list(rows, slow(150));
    expect(Date.now() - t0).toBeLessThan(600);
    expect(next.sessions.filter((s) => s.agent)).toHaveLength(AGENTS + 8);
    await rows.idle();
  });
});
