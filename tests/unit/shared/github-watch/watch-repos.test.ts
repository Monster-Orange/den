/**
 * Issue 1270: a project's `agents.watch_repos`, the extra repos its agents
 * may watch (read-only). Entries are checked where they are read: only
 * owner/name strings count, each once; anything else is dropped. The
 * watcher's GitHub client only ever reads.
 */
import { describe, expect, it } from "@jest/globals";
import {
  parseWatchRepos,
  projectWatchRepos,
  REPO_MAX,
  stripGit,
} from "../../../../src/shared/github-watch/watch-repos.js";
import { ghGet } from "../../../../src/shared/github-watch/gh-http.js";
import type { WorkspacesFile } from "../../../../src/shared/types/index.js";

// The quadratic regex took about 7 s on 400 KB; 1 s is far below that and
// leaves a busy machine room (a 50 ms bound flaked under load).
const FAST_MS = 1000;

describe("issue 1270: stripGit takes linear time", () => {
  it("a 400 KB run of .git that doesn't end the name is left as it is, fast", () => {
    const hostile = "a/" + ".git".repeat(100_000) + "x";
    const t0 = Date.now();
    expect(stripGit(hostile)).toBe(hostile);
    expect(Date.now() - t0).toBeLessThan(FAST_MS);
  });

  it("every trailing .git comes off (any case), fast", () => {
    const long = "a/b" + ".GiT".repeat(100_000);
    const t0 = Date.now();
    expect(stripGit(long)).toBe("a/b");
    expect(Date.now() - t0).toBeLessThan(FAST_MS);
    expect(stripGit("a/b.git.x")).toBe("a/b.git.x");
    expect(stripGit("a/b")).toBe("a/b");
  });
});

describe("issue 1270: parseWatchRepos", () => {
  it("keeps owner/name strings, each once, case kept from the first", () => {
    expect(
      parseWatchRepos(["shared/pipeline", "Shared/Pipeline", "acme/tools"]),
    ).toEqual(["shared/pipeline", "acme/tools"]);
  });

  it("a trailing .git is the same repo: dropped (any case), then each once", () => {
    expect(
      parseWatchRepos([
        "acme/south.git",
        "acme/South.GIT",
        "acme/south",
        "acme/.git",
        "acme/south.git.git",
        "acme/.git.git",
      ]),
    ).toEqual(["acme/south"]);
  });

  it("drops what isn't owner/name: a URL, a path, a dot segment, a number, an object", () => {
    expect(
      parseWatchRepos([
        "https://example.test/shared/pipeline",
        "shared/pipeline/extra",
        "../pipeline",
        "shared/..",
        "just-a-name",
        42,
        { repo: "shared/pipeline" },
        "",
      ]),
    ).toEqual([]);
  });

  it(`an entry over ${200} characters is dropped before it is stripped, fast`, () => {
    expect(REPO_MAX).toBe(200);
    const t0 = Date.now();
    expect(
      parseWatchRepos([
        "a/" + ".git".repeat(100_000) + "x",
        "a/" + "b".repeat(199),
        "acme/tools",
      ]),
    ).toEqual(["acme/tools"]);
    expect(Date.now() - t0).toBeLessThan(FAST_MS);
  });

  it("anything but a list is none", () => {
    for (const raw of [undefined, null, "shared/pipeline", {}, 7])
      expect(parseWatchRepos(raw)).toEqual([]);
  });
});

describe("issue 1270: projectWatchRepos", () => {
  const file = (agents: unknown): WorkspacesFile =>
    ({
      workspaces: { north: { agents } },
    }) as unknown as WorkspacesFile;

  it("reads the project's agents.watch_repos", () => {
    expect(
      projectWatchRepos("north", () =>
        file({ watch_repos: ["shared/pipeline"] }),
      ),
    ).toEqual(["shared/pipeline"]);
  });

  it("another project, none set, or an unreadable file: none", () => {
    expect(
      projectWatchRepos("west", () =>
        file({ watch_repos: ["shared/pipeline"] }),
      ),
    ).toEqual([]);
    expect(projectWatchRepos("north", () => file({}))).toEqual([]);
    expect(
      projectWatchRepos("north", () => {
        throw new Error("unreadable");
      }),
    ).toEqual([]);
  });
});

describe("issue 1270: the watcher's GitHub client only reads", () => {
  it("each call is `gh api -i <path>`: no method, no fields", async () => {
    const seen: string[][] = [];
    const get = ghGet(async (args) => {
      seen.push(args);
      return { code: 0, stdout: "HTTP/2.0 200 OK\r\n\r\n{}", stderr: "" };
    });
    await get("/repos/shared/pipeline/pulls/7");
    expect(seen).toEqual([["api", "-i", "/repos/shared/pipeline/pulls/7"]]);
  });
});
