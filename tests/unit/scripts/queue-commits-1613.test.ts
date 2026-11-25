/**
 * The queue's commit check: every commit on the merge queue's branch that
 * main hasn't got must be signed by a key in the allowed-signers file, and
 * its message must not match the names list. A commit on the allow-list
 * (by full SHA, with a reason) passes. The output names only SHAs and the
 * rule broken, never a message. A throwaway key, invented names in a temp
 * names file.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "queue-commits.mjs");

let dir: string;
let repo: string;
let names: string;
let key: string;
let otherKey: string;
let signers: string;
let allow: string;
let base: string;

function git(...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function check(range: string, env: Record<string, string> = {}) {
  return spawnSync(
    "node",
    [SCRIPT, range, "--signers", signers, "--allow", allow],
    {
      cwd: repo,
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH ?? "",
        DEN_ORG_NAMES_FILE: names,
        ...env,
      },
    },
  );
}

/** A commit signed with `signWith`, or unsigned when it's undefined. */
function commit(msg: string, signWith?: string): string {
  fs.writeFileSync(path.join(repo, "f.txt"), msg);
  git("add", "f.txt");
  const sign = signWith
    ? [
        "-c",
        "gpg.format=ssh",
        "-c",
        `user.signingkey=${signWith}`,
        "-c",
        "commit.gpgsign=true",
      ]
    : ["-c", "commit.gpgsign=false"];
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    ...sign,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-q",
    "-m",
    msg,
  );
  return git("rev-parse", "HEAD");
}

function makeKey(name: string): string {
  const k = path.join(dir, name);
  const r = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", k]);
  if (r.status !== 0) throw new Error(`ssh-keygen: ${r.stderr}`);
  return k;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "queue-commits-"));
  repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "queue");
  names = path.join(dir, "names.txt");
  fs.writeFileSync(names, "# invented\nzorblaxcorp\n");
  key = makeKey("agents");
  otherKey = makeKey("other");
  signers = path.join(dir, "signers");
  const pub = fs.readFileSync(`${key}.pub`, "utf-8").trim();
  fs.writeFileSync(signers, `den-agents namespaces="git" ${pub}\n`);
  allow = path.join(dir, "allow.json");
  fs.writeFileSync(allow, "[]\n");
  base = commit("start", key);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("issue 1613: the queue's commits", () => {
  it("signed by an allowed key, clean messages: passes", () => {
    commit("A plain change", key);
    commit("Another plain change", key);
    const r = check(`${base}..HEAD`);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/2 commit\(s\) signed and clean/);
    expect(r.status).toBe(0);
  });

  it("an unsigned commit fails, by SHA", () => {
    const from = git("rev-parse", "HEAD");
    const sha = commit("An unsigned change");
    const r = check(`${from}..HEAD`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      `${sha.slice(0, 12)} not signed by an allowed key`,
    );
    expect(r.stdout).not.toContain("An unsigned change");
  });

  it("a commit signed by a key not in the file fails", () => {
    const from = git("rev-parse", "HEAD");
    const sha = commit("Signed by someone else", otherKey);
    const r = check(`${from}..HEAD`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      `${sha.slice(0, 12)} not signed by an allowed key`,
    );
  });

  it("a signed commit whose message names a listed org fails, message withheld", () => {
    const from = git("rev-parse", "HEAD");
    const sha = commit("Merge pull request #7 from Zorblax Corp/rel", key);
    const r = check(`${from}..HEAD`);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(
      `${sha.slice(0, 12)} message matches pattern #1`,
    );
    expect(r.stdout + r.stderr).not.toMatch(/zorblax/i);
  });

  it("an allow-listed SHA passes, and the rest are still checked", () => {
    const from = git("rev-parse", "HEAD");
    const old = commit("Merge pull request #8 from Zorblax Corp/x");
    fs.writeFileSync(
      allow,
      JSON.stringify([{ sha: old, reason: "a merge-button commit" }]),
    );
    try {
      const ok = check(`${from}..HEAD`);
      expect(ok.status).toBe(0);
      // A log reader sees how many passed by the allow-list, not only
      // how many were checked.
      expect(ok.stdout).toMatch(
        /0 commit\(s\) signed and clean; 1 passed by the allow-list/,
      );
      const sha = commit("A later unsigned change");
      const r = check(`${from}..HEAD`);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(`${sha.slice(0, 12)} not signed`);
      expect(r.stdout).not.toContain(old.slice(0, 12));
    } finally {
      fs.writeFileSync(allow, "[]\n");
    }
  });

  it("an allow-list entry that isn't a full SHA with a reason is refused", () => {
    fs.writeFileSync(allow, JSON.stringify([{ sha: base.slice(0, 9) }]));
    try {
      const r = check(`${base}..${base}`);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/allow-list/);
    } finally {
      fs.writeFileSync(allow, "[]\n");
    }
  });

  it("no names list: refused, never a silent pass", () => {
    const r = check(`${base}..HEAD`, { DEN_ORG_NAMES: "" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no patterns/);
  });
});
