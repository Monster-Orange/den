/**
 * 0.4.9: "its pull request merged" (the rotation trigger, den#4) is
 * verified, never matched on text. A command counts as a merge only when
 * one of its parts, after a `cd` or `VAR=value` prefix, is `gh pr merge`
 * itself (not `--help`), and it exited 0. Then `usage` asks
 * `gh pr view <ref> --json state` and marks the record merged only when
 * the answer is MERGED. No gh, or any error: not marked.
 *
 * The real gh never runs: the check is injected.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { listRecords } from "../../../src/shared/agents/records.js";
import { ghPrState } from "../../../src/shared/git/gh-pr-state.js";
import { agentUsage } from "../../../src/shared/usage/report.js";
import {
  ghPrMergeRef,
  mineTranscript,
} from "../../../src/shared/usage/transcript.js";
import { writeUsageFixture } from "./fixture.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

describe("which commands are a merge", () => {
  it.each([
    ["gh pr merge 12 --squash", { ref: "12" }],
    ["gh pr merge --squash --delete-branch", { ref: "" }],
    ["cd /work/notes && GH_PAGER= gh pr merge 7 --merge", { ref: "7" }],
    [
      "gh pr merge https://github.com/acme/notes/pull/7 -R acme/notes",
      { ref: "https://github.com/acme/notes/pull/7", repo: "acme/notes" },
    ],
    ["git push && gh pr merge 3 --auto", { ref: "3" }],
  ])("%s → a merge", (cmd, want) => expect(ghPrMergeRef(cmd)).toEqual(want));

  it.each([
    "echo gh pr merge 1",
    "gh pr merge --help",
    "gh pr merge 4 -h",
    "grep 'gh pr merge' notes.txt",
    "cat log | grep gh pr merge",
    "gh pr view 1",
    "# gh pr merge 1",
  ])("%s → not a merge", (cmd) => expect(ghPrMergeRef(cmd)).toBeNull());
});

function line(o: unknown) {
  return JSON.stringify(o) + "\n";
}

function transcriptWith(cmd: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-prm-"));
  tmps.push(dir);
  const f = path.join(dir, "t.jsonl");
  fs.writeFileSync(
    f,
    line({
      type: "assistant",
      timestamp: "2026-11-01T10:00:00.000Z",
      message: {
        model: "claude-opus-5-5",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: cmd } },
        ],
      },
    }) +
      line({
        type: "user",
        timestamp: "2026-11-01T10:00:05.000Z",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "t1", content: "gh pr merge" },
          ],
        },
      }),
  );
  return f;
}

describe("the transcript", () => {
  it("`echo gh pr merge 1` (exit 0, output naming the command) is no merge", async () => {
    const s = await mineTranscript(transcriptWith("echo gh pr merge 1"));
    expect(s.prMerges).toEqual([]);
  });

  it("a real `gh pr merge 5` that exited 0 is a claim, still to be checked", async () => {
    const s = await mineTranscript(transcriptWith("gh pr merge 5 --squash"));
    expect(s.prMerges).toEqual([{ ref: "5" }]);
  });
});

describe("usage checks the claim with gh", () => {
  function fixture() {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-prm-")),
    );
    tmps.push(dir);
    const f = writeUsageFixture(dir);
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: path.join(dir, "claude") };
    return { ...f, env };
  }
  const agent1 = async (
    prState?: (
      ref: string,
      o: { repo?: string; cwd: string },
    ) => Promise<string | undefined>,
  ) => {
    const f = fixture();
    const rows = await agentUsage(listRecords(f.stateDir), {
      env: f.env,
      ...(prState ? { prState } : {}),
    });
    return rows.find((r) => r.agent === "agent-1")!.outcome!;
  };

  it("MERGED: marked; a bare `gh pr merge` is checked by the PR it opened", async () => {
    const asked: string[] = [];
    const o = await agent1(async (ref) => {
      asked.push(ref);
      return "MERGED";
    });
    expect(o.prMerged).toBe(true);
    expect(asked).toEqual(["https://github.com/acme/notes/pull/101"]);
  });

  it("OPEN, an error, or no check at all: not marked", async () => {
    expect((await agent1(async () => "OPEN")).prMerged).toBeUndefined();
    expect(
      (
        await agent1(async () => {
          throw new Error("gh: not found");
        })
      ).prMerged,
    ).toBeUndefined();
    expect((await agent1()).prMerged).toBeUndefined();
  });
});

describe("the gh check itself (a fake gh on PATH; the real one never runs)", () => {
  function fakeGh(body: string) {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-prm-gh-")),
    );
    tmps.push(dir);
    fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\n${body}\n`, {
      mode: 0o755,
    });
    return { dir, env: { PATH: `${dir}:/usr/bin:/bin` } };
  }

  it("asks for the state of that PR only, in the agent's folder", async () => {
    const g = fakeGh(
      'printf "%s\\n" "$PWD" "$@" > "$(dirname "$0")/argv"; echo MERGED',
    );
    const st = await ghPrState(g.env)("7", { repo: "acme/notes", cwd: g.dir });
    expect(st).toBe("MERGED");
    expect(
      fs.readFileSync(path.join(g.dir, "argv"), "utf-8").trim().split("\n"),
    ).toEqual([
      g.dir,
      "pr",
      "view",
      "7",
      "-R",
      "acme/notes",
      "--json",
      "state",
      "-q",
      ".state",
    ]);
  });

  it("gh failing, or not installed, rejects (so nothing is marked)", async () => {
    const g = fakeGh("echo 'no pull requests found' >&2; exit 1");
    await expect(ghPrState(g.env)("", { cwd: g.dir })).rejects.toBeTruthy();
    await expect(
      ghPrState({ PATH: path.join(g.dir, "nowhere") })("1", { cwd: g.dir }),
    ).rejects.toBeTruthy();
  });
});
