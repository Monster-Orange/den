import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  listRecords,
  writeRecord,
} from "../../../src/shared/agents/records.js";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

const AGENTS = 140;
const WATCH_MS = 6000;
const BOUND_MS = 500;
let tmp = "";
let home = "";
let srv: SlowGitServer;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-links-")));
  home = path.join(tmp, "home");
  const root = path.join(tmp, "dist");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    "active: north\nworkspaces:\n  north:\n    services: {}\n",
  );
  const now = new Date().toISOString();
  for (let i = 0; i < AGENTS; i++)
    writeRecord(home, {
      id: `old${i}`,
      persona: "tester",
      runtime: "den-claude",
      workspace: "north",
      cwd: tmp,
      session: { backend: "den-pty", id: `gone-${i}` },
      sessionName: `den-north:old${i}`,
      startedAt: now,
      stoppedAt: now,
    } as Parameters<typeof writeRecord>[1]);
  srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
}, 60_000);

afterAll(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("start-up upkeep: the one-time link migration of 140 agents", () => {
  it("links them all, and /api/server-info answers within 500 ms throughout (one synchronous pass of all 140 took about 700)", async () => {
    const a = srv.auth();
    const end = Date.now() + WATCH_MS;
    let worst = 0;
    let probes = 0;
    while (Date.now() < end) {
      const p = await srv.timed("/api/server-info", a);
      expect(p.status).toBe(200);
      worst = Math.max(worst, p.ms);
      probes++;
      await new Promise((r) => setTimeout(r, 50));
    }
    const linked = listRecords(home).filter((r) => r.project === "north");
    expect([linked.length, probes > 10]).toEqual([AGENTS, true]);
    expect(worst).toBeLessThan(BOUND_MS);
  }, 60_000);
});
