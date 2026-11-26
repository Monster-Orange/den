/**
 * Den's PreToolUse hook holds an agent's `gh` write
 * (pr/issue create, edit, comment, review; gh api writes) whose title or
 * body holds a listed name, before it runs, on a public repo only. The
 * refusal quotes the agent's own phrase and offers neutral words; it never
 * shows the list. The hook runs as Claude Code runs it, with a stand-in
 * `gh` on PATH that answers a repo's visibility and counts the asks.
 */
import { afterAll, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const dir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-pubtext-")),
);
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const bin = path.join(dir, "bin");
const calls = path.join(dir, "gh-calls.txt");
const vis = path.join(dir, "vis.json");
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "gh"),
  `#!${process.execPath}
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + "\\n");
const repo = (process.argv[3] || "").replace(/^repos\\//, "");
const v = JSON.parse(fs.readFileSync(${JSON.stringify(vis)}, "utf-8"))[repo] || "public";
if (v === "fail") process.exit(1);
process.stdout.write(v + "\\n");
`,
  { mode: 0o755 },
);

// Test names only: a regex line and a run-together name.
const LIST = "zorbl[a-z]+\nquuxcorp";

beforeEach(() => {
  fs.rmSync(calls, { force: true });
  fs.rmSync(path.join(dir, ".cache"), { recursive: true, force: true });
  fs.writeFileSync(
    vis,
    JSON.stringify({
      "acme/priv": "private",
      "acme/inside": "internal",
      "acme/down": "fail",
    }),
  );
});

fs.writeFileSync(path.join(dir, "body.md"), "first line\nsee zorblax.lan\n");
fs.writeFileSync(path.join(dir, "clean.md"), "nothing to see\n");
fs.writeFileSync(
  path.join(dir, "req.json"),
  JSON.stringify({ title: "ok", body: "from zorblax" }),
);

function hook(
  command: string,
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    args?: string[];
  } = {},
) {
  const r = spawnSync(process.execPath, [HOOK, ...(opts.args ?? [])], {
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: { command },
      cwd: opts.cwd ?? dir,
    }),
    encoding: "utf-8",
    // A variable given as undefined is left out (unset).
    env: Object.fromEntries(
      Object.entries({
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        HOME: dir,
        DEN_ORG_NAMES: LIST,
        ...opts.env,
      }).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
  });
  return { code: r.status, stderr: r.stderr };
}
const asks = () =>
  fs.existsSync(calls)
    ? fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean).length
    : 0;

const R = "-R acme/pub";

describe("each form of a gh write with a listed name is held", () => {
  it.each([
    [
      "--title",
      `gh pr create ${R} --title "Fix for zorblax" --body ok`,
      "title",
    ],
    ["-b", `gh pr create ${R} -t ok -b "talked to Zorblax today"`, "body"],
    ["--body=", `gh pr create ${R} --title=ok --body=zorblax`, "body"],
    [
      "--body-file",
      `gh pr create ${R} -t ok --body-file body.md`,
      "body file body.md, line 2",
    ],
    [
      "a heredoc in --body",
      `gh pr create ${R} -t ok --body "$(cat <<'EOF'\nfine\nzorblax here\nEOF\n)"`,
      "body, line 3",
    ],
    [
      "--body-file - from a heredoc",
      `gh pr create ${R} -t ok --body-file - <<'EOF'\nfine\nzorblax here\nEOF`,
      "body (stdin)",
    ],
    [
      "--body-file - from a pipe",
      `echo zorblax | gh pr comment 12 ${R} -F -`,
      "body (stdin)",
    ],
    [
      "$(cat file)",
      `gh pr create ${R} -t ok --body "$(cat body.md)"`,
      "body, line 2",
    ],
    ["pr edit", `gh pr edit 12 ${R} --body x-zorblax`, "body"],
    ["pr comment", `gh pr comment 12 ${R} -b zorblax`, "body"],
    ["pr review -r -b", `gh pr review 12 ${R} -r -b zorblax`, "body"],
    ["issue create", `gh issue create ${R} -t zorblax -b x`, "title"],
    ["issue edit", `gh issue edit 3 ${R} -b zorblax`, "body"],
    ["issue comment", `gh issue comment 3 ${R} --body zorblax`, "body"],
    ["-R first", `gh -R acme/pub issue comment 3 --body zorblax`, "body"],
    [
      "a run-together name, spaced",
      `gh issue comment 3 ${R} --body "Quux Corp said"`,
      "body",
    ],
    [
      "api -f",
      `gh api repos/acme/pub/issues -f title=ok -f body='zorblax'`,
      "field body",
    ],
    [
      "api -X PATCH",
      `gh api -X PATCH repos/acme/pub/issues/comments/9 -f body=zorblax`,
      "field body",
    ],
    [
      "api -F body=@file",
      `gh api repos/acme/pub/issues/3/comments -F body=@body.md`,
      "field body, line 2",
    ],
    [
      "api --input",
      `gh api repos/acme/pub/pulls --input req.json`,
      "input body",
    ],
    [
      "pr merge --subject",
      `gh pr merge 12 ${R} --squash --subject "zorblax fix"`,
      "subject",
    ],
    [
      "pr merge -t -b",
      `gh pr merge 12 ${R} -s -t ok -b "from zorblax"`,
      "body",
    ],
    [
      "pr merge --body-file",
      `gh pr merge 12 ${R} --body-file body.md`,
      "body file body.md, line 2",
    ],
    ["pr close -c", `gh pr close 12 ${R} -d -c "zorblax said no"`, "comment"],
    [
      "pr reopen --comment",
      `gh pr reopen 12 ${R} --comment zorblax`,
      "comment",
    ],
    [
      "issue close -c with -r",
      `gh issue close 3 ${R} -r "not planned" -c zorblax`,
      "comment",
    ],
    ["issue reopen -c", `gh issue reopen 3 ${R} -c zorblax`, "comment"],
    [
      "api graphql mutation",
      `gh api graphql -f query='mutation { addComment(input: {subjectId: "x", body: "zorblax"}) { clientMutationId } }'`,
      "field query",
    ],
  ])("%s", (_name, command, where) => {
    const r = hook(command);
    expect(r.stderr).toContain(where);
    expect(r.code).toBe(2);
  });
});

describe("the refusal lets one retry fix it", () => {
  it("quotes the agent's own phrase and neutral words, never the list", () => {
    const r = hook(`gh pr create ${R} -t ok -b "Ask Zorblaxia about it"`);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(`body, line 1: "Zorblaxia"`);
    expect(r.stderr).toContain("acme/pub is public");
    expect(r.stderr).toMatch(/"the person", "the project"/);
    expect(r.stderr).toMatch(/an internal host/);
    expect(r.stderr).not.toContain("zorbl[a-z]+");
    expect(r.stderr).not.toContain("quuxcorp");
  });

  it("the reworded command goes through", () => {
    expect(
      hook(`gh pr create ${R} -t ok -b "Ask the person about it"`).code,
    ).toBe(0);
  });
});

describe("what it leaves alone", () => {
  it.each([
    `gh pr create ${R} -t "Clean title" -b "clean body"`,
    `gh pr create ${R} -t ok --body-file clean.md`,
    `gh pr view 12 ${R}`,
    `gh pr list ${R} --search zorblax`,
    `gh issue list ${R} --search zorblax`,
    `gh api repos/acme/pub/issues`,
    `gh api -X GET repos/acme/pub/issues -f q=zorblax`,
    `echo zorblax`,
  ])("%s", (command) => {
    expect(hook(command).code).toBe(0);
  });

  it("clean text never asks GitHub anything", () => {
    hook(`gh pr create ${R} -t ok -b fine`);
    expect(asks()).toBe(0);
  });

  it("with no list configured, nothing is checked", () => {
    const r = hook(`gh pr create ${R} -t zorblax -b x`, {
      env: { DEN_ORG_NAMES: "" },
    });
    expect(r.code).toBe(0);
    expect(asks()).toBe(0);
  });
});

describe("public repos only, asked once", () => {
  it("a private repo's write goes through, and GitHub is asked once", () => {
    expect(hook(`gh pr create -R acme/priv -t zorblax -b x`).code).toBe(0);
    expect(hook(`gh issue comment 3 -R acme/priv -b zorblax`).code).toBe(0);
    expect(asks()).toBe(1);
  });

  it("an internal repo's write goes through", () => {
    expect(hook(`gh pr create -R acme/inside -t zorblax -b x`).code).toBe(0);
  });

  it("a public repo is asked once too, and held each time", () => {
    expect(hook(`gh pr create ${R} -t zorblax -b x`).code).toBe(2);
    expect(hook(`gh pr create ${R} -t zorblax -b x`).code).toBe(2);
    expect(asks()).toBe(1);
  });

  it("past the kept minutes, GitHub is asked again", () => {
    hook(`gh pr create -R acme/priv -t zorblax -b x`, {
      args: ["--visibility-minutes", "0"],
    });
    hook(`gh pr create -R acme/priv -t zorblax -b x`, {
      args: ["--visibility-minutes", "0"],
    });
    expect(asks()).toBe(2);
  });

  it("a repo whose visibility can't be found is checked", () => {
    const r = hook(`gh pr create -R acme/down -t zorblax -b x`);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/visibility isn't known/);
  });

  it("with no --repo, the cwd's remote decides", () => {
    const repo = path.join(dir, "checkout");
    fs.mkdirSync(repo, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repo });
    spawnSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/priv.git"],
      {
        cwd: repo,
      },
    );
    expect(hook(`gh pr create -t zorblax -b x`, { cwd: repo }).code).toBe(0);
    spawnSync(
      "git",
      ["remote", "set-url", "origin", "https://github.com/acme/pub.git"],
      {
        cwd: repo,
      },
    );
    const r = hook(`gh pr create -t zorblax -b x`, { cwd: repo });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("acme/pub is public");
  });

  it("a pull request named by URL is checked against that repo", () => {
    expect(
      hook(`gh pr comment https://github.com/acme/priv/pull/4 -b zorblax`).code,
    ).toBe(0);
    expect(
      hook(`gh pr comment https://github.com/acme/pub/pull/4 -b zorblax`).code,
    ).toBe(2);
  });
});

describe("a list that can't be read (the check's own failure)", () => {
  const missing = {
    DEN_ORG_NAMES: undefined,
    DEN_ORG_NAMES_FILE: path.join(dir, "no-such-list.txt"),
  };
  const bad = { DEN_ORG_NAMES: "zorblax\nqx(oops" };
  it.each([
    ["a missing names file", missing],
    ["a bad pattern line", bad],
  ])("%s: the other guardrails still refuse", (_n, env) => {
    const s = hook(`gh pr view 12 ${R}; sleep 30`, { env });
    expect(s.code).toBe(2);
    expect(s.stderr).toMatch(/sleep/);
    fs.writeFileSync(path.join(dir, "web.log"), "x\n");
    const c = hook(`gh pr list ${R} && cat web.log`, { env });
    expect(c.code).toBe(2);
    expect(c.stderr).toMatch(/a log/);
  });

  it.each([
    ["a missing names file", missing],
    ["a bad pattern line", bad],
  ])(
    "%s: a gh write is held with a clear message, never the list",
    (_n, env) => {
      const r = hook(`gh pr create ${R} -t ok -b fine`, { env });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/couldn't check/);
      expect(r.stderr).toMatch(/Nothing was sent/);
      expect(r.stderr).not.toContain("qx(oops");
      expect(r.stderr).not.toContain("no-such-list");
    },
  );

  it("a read-only gh command still goes through", () => {
    expect(hook(`gh pr view 12 ${R}`, { env: bad }).code).toBe(0);
  });
});

describe("with the other guardrails off", () => {
  it("--no-guardrails still holds a public write", () => {
    expect(
      hook(`gh pr create ${R} -t zorblax -b x`, { args: ["--no-guardrails"] })
        .code,
    ).toBe(2);
  });
});
