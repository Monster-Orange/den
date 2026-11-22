/**
 * Issue 1127: a scheduled job (.github/workflows/filed-text-scan.yml)
 * scans issues, pull requests and comments created or edited since its
 * last run for listed names (the DEN_ORG_NAMES secret, never the repo).
 * A hit files one finding per item, with a neutral title, a link and no
 * quoted match, and never edits the item. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { orgPatterns } from "../../../src/shared/org-names.js";

const ROOT = process.cwd();

interface Item {
  url: string;
  kind: "issue" | "pull request" | "comment";
  title?: string;
  body: string;
  updatedAt: string;
}
interface Finding {
  url: string;
  kind: string;
  hits: { field: string; line: number; index: number }[];
}
type Scan = {
  findingsFor: (
    items: Item[],
    patterns: RegExp[],
    since: string,
    repo: string,
  ) => Finding[];
  findingText: (f: Finding) => { title: string; body: string };
  itemsOf: (issues: unknown[], comments: unknown[]) => Item[];
  runScan: (o: {
    repo: string;
    findingsRepo?: string;
    findingsToken?: string;
    since: string;
    patterns: RegExp[];
    gh: (args: string[], o?: { input?: string; token?: string }) => string;
    log: (l: string) => void;
  }) => number;
};

// The script is an ES module: load it once.
let scan: Scan;
const load = async () =>
  (scan ??= (await import(
    path.join(ROOT, "scripts", "filed-text-scan.js")
  )) as Scan);

const LISTED = "zorblax";
const patterns = orgPatterns({ DEN_ORG_NAMES: LISTED });
const SINCE = "2026-11-20T00:00:00Z";
const NEW = "2026-11-21T00:00:00Z";
const OLD = "2026-11-19T00:00:00Z";

const issue = (n: number, body: string, updatedAt = NEW): Item => ({
  url: `https://github.com/o/r/issues/${n}`,
  kind: "issue",
  title: `Issue ${n}`,
  body,
  updatedAt,
});

describe("issue 1127: the scheduled scan", () => {
  it("finds a listed name in an issue body, a pull request body and a comment", async () => {
    const { findingsFor } = await load();
    const items: Item[] = [
      issue(1, "seen at Zorblax"),
      {
        url: "https://github.com/o/r/pull/2",
        kind: "pull request",
        title: "A fix",
        body: "for zorblax.example",
        updatedAt: NEW,
      },
      {
        url: "https://github.com/o/r/issues/3#issuecomment-9",
        kind: "comment",
        body: "ZORBLAX again",
        updatedAt: NEW,
      },
      issue(4, "clean text"),
    ];
    expect(
      findingsFor(items, patterns, SINCE, "o/r").map((f) => f.url),
    ).toEqual([items[0].url, items[1].url, items[2].url]);
  });

  it("skips items older than its last run", async () => {
    const { findingsFor } = await load();
    expect(
      findingsFor([issue(1, "zorblax", OLD)], patterns, SINCE, "o/r"),
    ).toEqual([]);
  });

  it("files one finding per item, not one per hit", async () => {
    const { findingsFor } = await load();
    const f = findingsFor(
      [{ ...issue(1, "zorblax\nand zorblax"), title: "zorblax" }],
      patterns,
      SINCE,
      "o/r",
    );
    expect(f).toHaveLength(1);
    expect(f[0].hits).toHaveLength(3);
  });

  it("the finding's text never contains the matched term, and links the item", async () => {
    const { findingsFor, findingText } = await load();
    const [f] = findingsFor([issue(1, "at Zorblax")], patterns, SINCE, "o/r");
    const t = findingText(f);
    expect(`${t.title}\n${t.body}`.toLowerCase()).not.toContain(LISTED);
    expect(t.body).toContain(f.url);
    expect(t.body).toContain("body line 1");
  });

  it("reads GitHub's issues (pull requests among them) and comments as items", async () => {
    const { itemsOf } = await load();
    const items = itemsOf(
      [
        {
          html_url: "https://github.com/o/r/issues/1",
          title: "t",
          body: null,
          updated_at: NEW,
        },
        {
          html_url: "https://github.com/o/r/pull/2",
          title: "p",
          body: "b",
          updated_at: NEW,
          pull_request: {},
        },
      ],
      [
        {
          html_url: "https://github.com/o/r/issues/1#issuecomment-5",
          body: "c",
          updated_at: NEW,
        },
      ],
    );
    expect(items.map((i) => [i.kind, i.body])).toEqual([
      ["issue", ""],
      ["pull request", "b"],
      ["comment", "c"],
    ]);
  });

  it("the workflow runs daily and on demand, reads the list from a secret, and can file issues", () => {
    const wf = yaml.parse(
      fs.readFileSync(
        path.join(ROOT, ".github", "workflows", "filed-text-scan.yml"),
        "utf-8",
      ),
    ) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: Record<
        string,
        {
          env?: Record<string, string>;
          steps: {
            id?: string;
            if?: string;
            uses?: string;
            run?: string;
            with?: Record<string, string>;
            env?: Record<string, string>;
          }[];
        }
      >;
    };
    expect(wf.on.schedule).toBeDefined();
    expect(wf.on).toHaveProperty("workflow_dispatch");
    // This repo's token only reads: findings go elsewhere.
    expect(wf.permissions.issues).toBe("read");
    // Pull requests and review comments read with their own grant.
    expect(wf.permissions["pull-requests"]).toBe("read");
    const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
    const scanStep = steps.find((s) =>
      (s.run ?? "").includes("filed-text-scan.mjs"),
    );
    expect(scanStep?.env?.DEN_ORG_NAMES).toBe("${{ secrets.DEN_ORG_NAMES }}");
    expect(scanStep?.env?.FILED_TEXT_FINDINGS_REPO).toBe(
      "${{ vars.FILED_TEXT_FINDINGS_REPO }}",
    );
    // No personal token: a GitHub App's, minted per run for the findings
    // repo only, by an action pinned to a full commit.
    const app = steps.find((s) =>
      (s.uses ?? "").startsWith("actions/create-github-app-token@"),
    );
    expect(app?.uses).toMatch(
      /^actions\/create-github-app-token@[0-9a-f]{40}( |$)/,
    );
    expect(app?.with?.["app-id"]).toBe("${{ secrets.DEN_FINDINGS_APP_ID }}");
    expect(app?.with?.["private-key"]).toBe(
      "${{ secrets.DEN_FINDINGS_APP_KEY }}",
    );
    // The App's repo comes from the findings variable (the part after the
    // slash), by a step before it: never a repo name written here.
    const nameStep = steps.find((s) =>
      (s.run ?? "").includes("FILED_TEXT_FINDINGS_REPO"),
    );
    expect(nameStep?.id).toBeDefined();
    expect(steps.indexOf(nameStep!)).toBeLessThan(steps.indexOf(app!));
    expect(nameStep?.env?.FILED_TEXT_FINDINGS_REPO).toBe(
      "${{ vars.FILED_TEXT_FINDINGS_REPO }}",
    );
    expect(app?.with?.repositories).toBe(
      `\${{ steps.${nameStep?.id}.outputs.name }}`,
    );
    // Missing App secrets: the step is skipped, the scan still runs and
    // fails safely (a count and numbers only).
    expect(app?.if).toBeDefined();
    expect(scanStep?.env?.FILED_TEXT_FINDINGS_TOKEN).toBe(
      `\${{ steps.${app?.id}.outputs.token }}`,
    );
    const text = fs.readFileSync(
      path.join(ROOT, ".github", "workflows", "filed-text-scan.yml"),
      "utf-8",
    );
    expect(text).not.toContain("secrets.FILED_TEXT_FINDINGS_TOKEN");
    expect(text).not.toMatch(/repositories:\s*[\w.-]+\s*$/m);
  });

  it("a bad line in the list: the command fails naming its line number only", () => {
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "filed-text-scan.mjs"), "--repo", "o/r"],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH,
          DEN_ORG_NAMES: "zorblax\nqx(secretword",
        },
        timeout: 60_000,
      },
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("line 2");
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/qx|secretword|zorblax/);
  });

  it("findings carry the findings repo's own label", async () => {
    const m = (await load()) as Scan & { FINDING_LABEL: string };
    expect(m.FINDING_LABEL).toBe("filed-text-finding");
  });

  describe("a run: findings go to a private repo, and no output holds item text", () => {
    const TITLE = "Secret launch plan";
    const issues = [
      {
        html_url: "https://github.com/o/r/issues/12",
        title: TITLE,
        body: "meeting at Zorblax HQ",
        updated_at: NEW,
      },
    ];
    const comments = [
      {
        html_url: "https://github.com/o/r/issues/12#issuecomment-345",
        body: "zorblax said so",
        updated_at: NEW,
      },
    ];
    function fakeGh() {
      const calls: { args: string[]; input?: string; token?: string }[] = [];
      const gh = (
        args: string[],
        o: { input?: string; token?: string } = {},
      ) => {
        calls.push({ args, ...o });
        const p = args[args.length - 1] ?? "";
        if (args[0] === "api" && p.startsWith("repos/o/r/issues?"))
          return JSON.stringify([issues]);
        if (args[0] === "api" && p.startsWith("repos/o/r/issues/comments"))
          return JSON.stringify([comments]);
        if (args[0] === "api") return JSON.stringify([[]]);
        return "";
      };
      return { gh, calls };
    }
    const leaks = (text: string) =>
      [LISTED, "secret launch", "meeting", "said so"].filter((w) =>
        text.toLowerCase().includes(w),
      );

    it("with no findings repo set it fails, logging only a count and the items' numbers", async () => {
      const { runScan } = await load();
      const f = fakeGh();
      const lines: string[] = [];
      const code = runScan({
        repo: "o/r",
        since: SINCE,
        patterns,
        gh: f.gh,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(1);
      const out = lines.join("\n");
      expect(out).toContain("issue 12");
      expect(out).toContain("comment 345");
      expect(leaks(out)).toEqual([]);
      expect(f.calls.filter((c) => c.args[0] !== "api")).toEqual([]);
    });

    it("the scanned repo is never a findings repo", async () => {
      const { runScan } = await load();
      const f = fakeGh();
      const code = runScan({
        repo: "o/r",
        findingsRepo: "o/r",
        findingsToken: "t",
        since: SINCE,
        patterns,
        gh: f.gh,
        log: () => undefined,
      });
      expect(code).toBe(1);
      expect(f.calls.filter((c) => c.args[1] === "create")).toEqual([]);
    });

    it("files one finding per item in the findings repo, with its token; no log line or finding holds item text", async () => {
      const { runScan } = await load();
      const f = fakeGh();
      const lines: string[] = [];
      const code = runScan({
        repo: "o/r",
        findingsRepo: "o/private-findings",
        findingsToken: "findings-token",
        since: SINCE,
        patterns,
        gh: f.gh,
        log: (l) => lines.push(l),
      });
      expect(code).toBe(0);
      const made = f.calls.filter(
        (c) => c.args[0] === "issue" && c.args[1] === "create",
      );
      expect(made).toHaveLength(2);
      for (const c of made) {
        expect(c.args).toContain("o/private-findings");
        expect(c.args).not.toContain("o/r");
        expect(c.token).toBe("findings-token");
        expect(leaks(`${c.args.join(" ")}\n${c.input ?? ""}`)).toEqual([]);
      }
      expect(leaks(lines.join("\n"))).toEqual([]);
    });
  });
});
