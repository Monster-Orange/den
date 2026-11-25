/**
 * Issue 237, part 2: the Tests page read every repo's branch and short
 * commit at once, two git processes per repo, with no limit. Now at most
 * git_reads.at_once (user.yml; 16 by default, 1 to 64) run at a time.
 */
import { describe, expect, it } from "@jest/globals";
import { readRepoHeads } from "../../../src/ui/server/test-sources.js";
import { GIT_READS, gitReadsAtOnce } from "../../../src/shared/git-reads.js";

describe("issue 237: the Tests page's git reads are bounded", () => {
  const repos = Array.from({ length: 30 }, (_, i) => ({
    repoName: `r${i}`,
    repoPath: `/repos/r${i}`,
  }));

  it.each([1, 4, 16])(
    "30 repos, at once %i: never more git reads than that, every repo answered in order",
    async (atOnce) => {
      let now = 0;
      let most = 0;
      const read = async (args: string[], cwd: string) => {
        most = Math.max(most, ++now);
        await new Promise((r) => setTimeout(r, 2));
        now--;
        return args.includes("--short") ? `sha-${cwd}` : `br-${cwd}`;
      };
      const heads = await readRepoHeads(repos, atOnce, read);
      expect(most).toBe(atOnce);
      expect(heads).toHaveLength(30);
      expect(heads[7]).toEqual({
        repoName: "r7",
        repoPath: "/repos/r7",
        branch: "br-/repos/r7",
        shortSha: "sha-/repos/r7",
      });
    },
  );

  it("git_reads.at_once: 16 unset, an integer from 1 to 64, else the default", () => {
    expect(GIT_READS).toEqual({ default: 16, min: 1, max: 64 });
    expect(gitReadsAtOnce(() => ({}))).toBe(16);
    expect(gitReadsAtOnce(() => ({ git_reads: { at_once: 4 } }))).toBe(4);
    for (const bad of [0, 65, 2.5, "8", null])
      expect(gitReadsAtOnce(() => ({ git_reads: { at_once: bad } }))).toBe(16);
    expect(
      gitReadsAtOnce(() => {
        throw new Error("unreadable");
      }),
    ).toBe(16);
  });
});
