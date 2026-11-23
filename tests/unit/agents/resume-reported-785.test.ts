/**
 * Issue 785, slice 2: a runtime other than Claude (Codex here) resumes
 * with the command its agent reported, checked again when it runs; a
 * missing or refused one says why, and Resume is refused.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  resolveAgentsDeps,
  resumeRefusal,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

/** A `codex` on the rig's PATH (its first folder). */
function codexOnPath(r: Rig): string {
  const bin = path.join(r.dir, "bin", "codex");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

/** A stopped Codex agent in north, with `report` when given. */
function stoppedCoder(r: Rig, report?: Record<string, unknown>): void {
  writeRecord(r.stateDir, {
    id: "coder",
    persona: "planner",
    runtime: "codex",
    workspace: "north",
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: "gone-coder" },
    sessionName: "acme-north:coder",
    startedAt: "2026-11-06T09:30:00.000Z",
    stoppedAt: "2026-11-06T10:30:00.000Z",
    ...(report ? { resumeReport: report } : {}),
  } as never);
}

async function row(r: Rig) {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
  return (JSON.parse(r.out.join("\n")) as Record<string, unknown>[]).find(
    (x) => x.agent === "coder",
  );
}

describe("issue 785: a Codex agent resumes with the command it reported", () => {
  it("resumable; Resume runs its words, the first from PATH, in its folder", async () => {
    const r = await rig();
    const bin = codexOnPath(r);
    stoppedCoder(r, {
      argv: ["codex", "resume", "019a-77"],
      cwd: r.wsDir("north"),
      seq: 3,
    });
    expect(await row(r)).toMatchObject({ resumable: true });
    expect(await agents(r, "resume", "coder")).toBe(0);
    const p = r.made[r.made.length - 1];
    expect(p.file).toBe(bin);
    expect(p.args).toEqual(["resume", "019a-77"]);
  });

  it("none reported: says so, and Resume is refused", async () => {
    const r = await rig();
    codexOnPath(r);
    stoppedCoder(r);
    expect(await row(r)).toMatchObject({
      resumable: false,
      noResume: "codex can't resume coder: it reported no resume command",
    });
    expect(await agents(r, "resume", "coder")).toBe(1);
    expect(r.err.join("\n")).toMatch(/it reported no resume command/);
    expect(r.made).toHaveLength(0);
  });

  it("reported for another folder: refused, naming both", async () => {
    const r = await rig();
    codexOnPath(r);
    stoppedCoder(r, {
      argv: ["codex", "resume", "019a-77"],
      cwd: r.wsDir("south"),
      seq: 1,
    });
    const got = await row(r);
    expect(got?.resumable).toBe(false);
    expect(got?.noResume).toMatch(
      /codex can't resume coder: its resume command was reported for .*south, not .*north/,
    );
  });

  it("its command not on PATH any more: refused, naming it", async () => {
    const r = await rig();
    // A name no machine has (a real codex may be in a well-known folder).
    stoppedCoder(r, {
      argv: ["nosuchcli-785", "resume", "019a-77"],
      cwd: r.wsDir("north"),
      seq: 1,
    });
    expect(
      resumeRefusal(
        JSON.parse(
          fs.readFileSync(
            path.join(r.stateDir, "agents", "coder.json"),
            "utf-8",
          ),
        ),
        resolveAgentsDeps(r.deps).env,
      ),
    ).toBe("codex can't resume coder: nosuchcli-785 is not on PATH");
  });
});
