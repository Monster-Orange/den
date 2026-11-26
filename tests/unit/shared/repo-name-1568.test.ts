/**
 * One owner/name check for every GitHub repo Den takes. It
 * refuses "." and ".." on either side and a leading "-", as GitHub does:
 * a URL parser folds a "." or ".." segment into another path, so a call
 * would go where the code never meant. Each caller refuses those before it
 * reads or fetches anything.
 */
import { describe, expect, it } from "@jest/globals";
import {
  boxRunnerAppRefs,
  mintBoxRunnerToken,
} from "../../../src/shared/gates/box-runner-token.js";
import { checkSpec } from "../../../src/shared/gates/box-runners.js";
import { checkRunnerEntry } from "../../../src/shared/gates/runner-entries.js";
import {
  projectList,
  readSyncReply,
} from "../../../src/shared/hub/hub-project-sync.js";
import type { WorkspacesFile } from "../../../src/shared/types/index.js";
import { checkIssueWrite } from "../../../src/shared/issue-write.js";
import {
  feedbackSettings,
  repoOfUrl,
} from "../../../src/shared/report-store.js";
import {
  isRepoName,
  parseRepoName,
  REPO_NAME_MAX,
  REPO_OWNER_MAX,
} from "../../../src/shared/repo-name.js";
import { isGitRemote } from "../../../src/shared/environment-manager/git-remote.js";
import { cloneTarget } from "../../../src/shared/repo-clone.js";
import { connectRepos } from "../../../src/ui/server/hub-connect.js";
import { githubRepo } from "../../../src/ui/server/pin-commit.js";
import { reportShotHub } from "../../../src/ui/server/report-shot-hub.js";

/** Each folds into another path in a URL. */
const FOLDS = ["owner/..", "owner/.", "../name", "./name", "../.."];

describe("the shared check (issue 1568)", () => {
  it.each([
    "acme-co/web-app",
    "acme/.github",
    "acme/den.js",
    "acme/my_repo",
    "user_shortcode/x",
    "Acme/Web",
    `${"o".repeat(REPO_OWNER_MAX)}/${"n".repeat(REPO_NAME_MAX)}`,
  ])("%s is a repo", (r) => {
    expect(isRepoName(r)).toBe(true);
  });

  it.each([
    ...FOLDS,
    "-owner/name",
    "owner/-name",
    "a.b/name",
    `${"o".repeat(REPO_OWNER_MAX + 1)}/n`,
    `o/${"n".repeat(REPO_NAME_MAX + 1)}`,
    "owner/name/x",
    "owner",
    "",
    "/name",
    "owner/",
    "owner/ name",
    "owner/na\nme",
    "owner%2F../name",
  ])("%j is refused", (r) => {
    expect(isRepoName(r)).toBe(false);
    expect(parseRepoName(r)).toBeNull();
  });

  it("parses the owner and the name", () => {
    expect(parseRepoName("acme-co/web.app")).toEqual({
      owner: "acme-co",
      name: "web.app",
    });
  });

  it("anything but a string is refused", () => {
    for (const v of [undefined, null, 1, {}, ["a/b"]])
      expect(isRepoName(v)).toBe(false);
  });
});

describe("every caller refuses a repo that folds into another path (issue 1568)", () => {
  it.each(FOLDS)("issue writes: %s", (repo) => {
    const r = checkIssueWrite({
      action: "create",
      repo,
      title: "t",
      body: "b",
    });
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringMatching(/^repo:/) });
  });

  it.each(FOLDS)("the feedback repo, from a URL or set: %s", (repo) => {
    expect(repoOfUrl(`https://github.com/${repo}/issues`)).toBeNull();
    expect(feedbackSettings(null, { repo }, {}).repos).toEqual([]);
  });

  it.each(FOLDS)("Hub sync's project list and reply: %s", (repo) => {
    const file = { workspaces: { web: {} } } as unknown as WorkspacesFile;
    expect(projectList(file, () => [repo])[0]!.repos).toEqual([]);
    const r = readSyncReply({
      uncovered: [
        {
          workspace: "web",
          repo,
          org: "acme",
          install_url: "https://github.com/apps/den-hub/installations/new",
        },
      ],
    });
    expect(r.uncovered).toEqual([]);
  });

  it.each(FOLDS)("Connect's repos: %s", (repo) => {
    expect(connectRepos(["web"], () => [repo])).toEqual([]);
  });

  it.each(FOLDS)(
    "a report's screenshot to Hub: %s, before Hub is asked",
    async (repo) => {
      let asked = 0;
      const h = reportShotHub({
        hub: async () => {
          asked++;
          return { url: "https://hub.example", token: "t" };
        },
        fetch: (async () => {
          asked++;
          throw new Error("never fetched");
        }) as unknown as typeof fetch,
      });
      expect(await h.preflight(repo)).toMatchObject({ ok: false });
      const png = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
      ]);
      expect(await h.upload(png, { draftId: "d1", targetRepo: repo })).toEqual({
        ok: false,
        why: "refused",
      });
      expect(asked).toBe(0);
    },
  );

  it.each(FOLDS)(
    "the pin's branch rules, from a remote URL a repo's .git/config holds: %s",
    (repo) => {
      for (const u of [
        `https://github.com/${repo}`,
        `https://github.com/${repo}.git`,
        `git@github.com:${repo}.git`,
      ])
        expect(githubRepo(u)).toBeNull();
    },
  );

  it.each(FOLDS)("a clone's GitHub slug: %s", (repo) => {
    expect(cloneTarget({ source: repo }, "/tmp/den-repos").ok).toBe(false);
    // not a slug, and not a remote Den hands to git either
    expect(isGitRemote(repo)).toBe(true);
  });

  it.each(FOLDS)("CI runner entries: %s", (repo) => {
    expect(checkRunnerEntry({ repo, box: "mini" }).ok).toBe(false);
  });

  it.each(FOLDS)("box runners: %s", (repo) => {
    const r = checkSpec({
      project: "web",
      box: "mini",
      repo,
      labels: ["self-hosted"],
      cpus: 1,
    } as Parameters<typeof checkSpec>[0]);
    expect(r).toEqual({ ok: false, error: "repo must be owner/name" });
  });

  it.each(FOLDS)(
    "a box runner's token: %s, before a secret or GitHub is asked",
    async (repo) => {
      let asked = 0;
      const r = await mintBoxRunnerToken(
        repo,
        boxRunnerAppRefs({ vault: "ci", item: "Runner App" })!,
        {
          provider: {
            tryGet: async () => {
              asked++;
              return null;
            },
          },
          fetch: (async () => {
            asked++;
            throw new Error("never fetched");
          }) as unknown as typeof fetch,
        } as unknown as Parameters<typeof mintBoxRunnerToken>[2],
      );
      expect(r).toMatchObject({ ok: false });
      expect(asked).toBe(0);
    },
  );
});
