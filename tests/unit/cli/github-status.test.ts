/**
 * The shared GitHub watcher's one status line, for doctor and for
 * `<cli> github status`: GitHub calls left, the reset time, the active
 * watches and the current interval; paused, why and until when. Read from
 * the server's <state>/github/watch-status.json; nothing when the server
 * hasn't written it. No network.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { githubWatchLine } from "../../../src/shared/github-watch/status-line.js";
import { cmdGithub } from "../../../src/ui/cli/github-command.js";

const base = {
  at: "2030-01-01T12:00:00.000Z",
  remaining: 4210,
  limit: 5000,
  resetAt: "2030-01-01T12:40:00.000Z",
  active: 3,
  intervalSeconds: 120,
  pausedUntil: null,
  pausedWhy: null,
};

describe("the GitHub watch status line", () => {
  it("says the calls left, the reset, the watches and the interval", () => {
    const l = githubWatchLine(base)!;
    expect(l.ok).toBe(true);
    expect(l.text).toContain("4210 of 5000");
    expect(l.text).toContain("2030-01-01T12:40:00.000Z");
    expect(l.text).toContain("3 watches");
    expect(l.text).toContain("120 s");
  });

  it("says when it is paused, why and until when", () => {
    const l = githubWatchLine({
      ...base,
      remaining: 120,
      pausedUntil: "2030-01-01T12:40:00.000Z",
      pausedWhy: "budget",
    })!;
    expect(l.ok).toBe(false);
    expect(l.text).toMatch(/paused until 2030-01-01T12:40:00.000Z/);
    expect(l.text).toMatch(/budget/);
  });

  it("nothing yet: no line", () => {
    expect(githubWatchLine(null)).toBeNull();
  });
});

describe("<cli> github status", () => {
  it("prints the line from the server's status file, or says there is none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ghstatus-"));
    try {
      const out: string[] = [];
      expect(
        await cmdGithub(["status"], { stateDir: dir, out: (l) => out.push(l) }),
      ).toBe(0);
      expect(out.join("\n")).toMatch(/no GitHub watch/i);
      fs.mkdirSync(path.join(dir, "github"));
      fs.writeFileSync(
        path.join(dir, "github", "watch-status.json"),
        JSON.stringify(base),
      );
      out.length = 0;
      await cmdGithub(["status"], { stateDir: dir, out: (l) => out.push(l) });
      expect(out.join("\n")).toContain("4210 of 5000");
      out.length = 0;
      await cmdGithub(["status", "--json"], {
        stateDir: dir,
        out: (l) => out.push(l),
      });
      expect(JSON.parse(out.join("\n"))).toMatchObject({ remaining: 4210 });
      expect(
        await cmdGithub(["nope"], {
          stateDir: dir,
          out: () => {},
          err: () => {},
        }),
      ).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
