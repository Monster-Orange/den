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
} from "../../../../src/shared/github-watch/watch-repos.js";
import { ghGet } from "../../../../src/shared/github-watch/gh-http.js";
import type { WorkspacesFile } from "../../../../src/shared/types/index.js";

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
