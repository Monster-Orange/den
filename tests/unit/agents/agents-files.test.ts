/**
 * AG-DROP-2: `<cli> agents files <id>` lists the files dropped, pasted or
 * attached onto an agent's terminal (its session's uploads), newest first;
 * --json for scripts. An unknown agent, or one in another workspace, is
 * an error.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { listUploads } from "../../../src/shared/agents/uploads.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(async () => {
  await cleanupRigs();
});

async function withAgent() {
  const r = await rig();
  writeRecord(r.stateDir, {
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: "a1b2c3d4" },
    sessionName: "den-north:scout",
    startedAt: new Date().toISOString(),
  } as never);
  const dir = path.join(r.stateDir, "uploads", "a1b2c3d4");
  fs.mkdirSync(dir, { recursive: true });
  const put = (name: string, bytes: number, ago: number) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, Buffer.alloc(bytes));
    const t = (Date.now() - ago) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };
  const older = put("20261110-000000-000-a.png", 2048, 86_400_000);
  const newer = put("20261111-000000-000-b.txt", 10, 60_000);
  put("20261111-000001-000-c.bin.part", 5, 1_000);
  return { r, dir, older, newer };
}

describe("agents files (AG-DROP-2)", () => {
  it("lists its uploads newest first, with size and path; never a part file", async () => {
    const { r, older, newer } = await withAgent();
    expect(await cmdAgents(["files", "scout"], r.deps)).toBe(0);
    expect(r.out[0]).toMatch(/ago\s+10 B {2}.*20261111-000000-000-b\.txt$/);
    expect(r.out[0]).toContain(newer);
    expect(r.out[1]).toMatch(/ago\s+2 KB {2}/);
    expect(r.out[1]).toContain(older);
    expect(r.out[2]).toBe(
      "2 files; each is removed 7 days after it came (agents.uploads.keep_days)",
    );
    expect(r.out.join("\n")).not.toContain(".part");
  });

  it("--json: the agent, its folder and each file", async () => {
    const { r, dir, newer } = await withAgent();
    expect(await cmdAgents(["files", "scout", "--json"], r.deps)).toBe(0);
    const j = JSON.parse(r.out.join("\n")) as {
      agent: string;
      folder: string;
      files: { path: string; bytes: number; at: string }[];
    };
    expect(j.agent).toBe("scout");
    expect(j.folder).toBe(dir);
    expect(j.files.map((f) => f.path)[0]).toBe(newer);
    expect(j.files).toHaveLength(2);
  });

  it("says so when there are none; refuses an unknown agent or the wrong workspace", async () => {
    const { r, dir } = await withAgent();
    fs.rmSync(dir, { recursive: true });
    expect(await cmdAgents(["files", "scout"], r.deps)).toBe(0);
    expect(r.out.at(-1)).toContain("no files for scout yet");
    expect(await cmdAgents(["files", "nobody"], r.deps)).toBe(1);
    expect(await cmdAgents(["files", "scout", "-w", "south"], r.deps)).toBe(1);
    expect(r.err.join("\n")).toContain('no agent "scout" in south');
  });

  it("lists nothing for a session id that isn't one", () => {
    expect(listUploads("/nowhere", "../x")).toEqual([]);
  });
});
