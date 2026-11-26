import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve("src/shared/agents/guardrails/pretooluse.mjs");
const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1747-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const shared = path.join(root, "shared", "node_modules");
fs.mkdirSync(path.join(shared, "jest"), { recursive: true });
const linked = path.join(root, "linked");
fs.mkdirSync(linked);
fs.symlinkSync(shared, path.join(linked, "node_modules"));
const real = path.join(root, "real");
fs.mkdirSync(path.join(real, "node_modules", "jest"), { recursive: true });

function bash(command: string, cwd: string) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }),
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "", HOME: root },
  });
  return { code: r.status, stderr: r.stderr };
}

const EMPTIES = [
  "npm ci",
  "npm install",
  "npm i",
  "npm prune",
  "pnpm install",
  "yarn install",
  "rm -rf node_modules/",
  "rm -rf node_modules/*",
  "git clean -fdx",
  "git clean -x -f",
  "env npm ci",
  "env FOO=1 npm ci",
  "npx npm ci",
  "npm exec -- npm ci",
  "corepack npm ci",
  "corepack pnpm install",
  "nice npm ci",
  "nice -n 5 npm ci",
  "xargs npm ci",
  "bash -c 'npm ci'",
  'sh -c "npm install"',
  "bash -lc 'cd . && npm ci'",
  "npm --loglevel silent ci",
  "npm --workspace x install",
  "npm -w x ci",
  "npm clean-install",
  "npm install-clean",
  "npm cit",
  "npm it",
  "find node_modules/ -delete",
];

describe("issue 1747: nothing empties a node_modules reached through a link", () => {
  it.each(EMPTIES)(
    "`%s` is refused where node_modules is a link, with the safe form",
    (command) => {
      const r = bash(command, linked);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("~/shared/node_modules");
      expect(r.stderr).toContain("`rm node_modules`");
    },
  );

  it.each(EMPTIES)(
    "`%s` is allowed where node_modules is a real folder",
    (command) => {
      expect(bash(command, real)).toMatchObject({ code: 0, stderr: "" });
    },
  );

  it.each([
    ["after a cd into the worktree", `cd ${linked} && npm ci`, root],
    ["with its output sent away", "npm ci > /dev/null 2>&1", linked],
    ["with --prefix", `npm ci --prefix ${linked}`, root],
    [
      "after a cd into the link's own path",
      `cd ${linked}; rm -rf node_modules/*`,
      root,
    ],
  ])("it is refused %s", (_what, command, cwd) => {
    expect(bash(command, cwd).code).toBe(2);
  });

  it.each([
    "npm ci --prefix $PWD",
    'npm ci "$EXTRA"',
    "npm ci $(echo)",
    "rm -rf $PWD/node_modules/",
    "npm ci `echo`",
    'bash -c "$CMD"',
  ])(
    "`%s` can't be read, so it is refused where node_modules is a link",
    (command) => {
      const r = bash(command, linked);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("can't tell where it");
    },
  );

  it("a cd before an unreadable install is followed", () => {
    expect(bash(`cd ${linked} && npm ci $X`, real).code).toBe(2);
    expect(bash(`cd ${real} && npm ci $X`, linked).code).toBe(0);
  });

  it("the home folder is shown as ~", () => {
    const r = bash("npm ci", linked);
    expect(r.stderr).toContain("~/linked/node_modules");
    expect(r.stderr).not.toContain(`${root}/linked`);
  });

  it.each([
    "rm node_modules",
    "rm -rf node_modules",
    "rm node_modules && npm ci",
    "npm run build",
    "npm test",
    "git clean -fd",
    "git clean -ndx",
    "env FOO=1 npm test",
    "bash -c 'npm run build'",
    "npx jest",
    "find node_modules -name x",
  ])("`%s` on a linked worktree is allowed", (command) => {
    expect(bash(command, linked)).toMatchObject({ code: 0, stderr: "" });
  });
});
