/**
 * SRV-P3 (0.4.48): repo_clone clones a repo into the folder Den finds
 * repos in (repos_root), for manifest_draft and repo_add to take up. The
 * check touches no network and writes nothing; a GitHub repo uses the
 * person's gh login, any other remote plain git and their own
 * credentials (SEC-0). The clone runs without a shell.
 *
 * A real `git clone` of a local file:// repo only (no network, no gh).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { cloneTarget, runClone } from "../../../src/shared/repo-clone.js";

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0))
    fs.rmSync(t, { recursive: true, force: true });
});
function tmp(): string {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "den-clone-"));
  tmps.push(t);
  return t;
}

describe("SRV-P3: what repo_clone would clone", () => {
  it("an owner/name is GitHub's, with the person's gh login; the folder is repos_root/<name>", () => {
    const root = tmp();
    const t = cloneTarget({ source: "acme/notes" }, root);
    expect(t).toEqual({
      ok: true,
      url: "https://github.com/acme/notes.git",
      shown: "acme/notes",
      name: "notes",
      dest: path.join(root, "notes"),
      gh: true,
    });
  });

  it("a github.com URL uses gh too; another remote plain git, its user info never shown", () => {
    const root = tmp();
    const gh = cloneTarget(
      { source: "https://github.com/acme/notes.git", name: "notes-2" },
      root,
    );
    expect(gh.ok && [gh.gh, gh.name]).toEqual([true, "notes-2"]);
    const other = cloneTarget(
      { source: "https://bob:s3cret@git.example.test/team/shop.git" },
      root,
    );
    expect(other.ok && other.gh).toBe(false);
    expect(other.ok && other.shown).toBe(
      "https://***@git.example.test/team/shop.git",
    );
  });

  it("refuses a folder there already, a local path, a bad name or branch, and anything a shell would read", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "notes"));
    const why = (a: Record<string, string>) => {
      const t = cloneTarget(a as never, root);
      return t.ok ? "" : t.error;
    };
    expect(why({ source: "acme/notes" })).toMatch(
      /already a folder at .*notes: repo_add it instead/,
    );
    expect(why({ source: "/somewhere/else" })).toMatch(
      /repo_add takes a local folder/,
    );
    expect(why({ source: "acme/x", name: "../up" })).toMatch(/name/);
    expect(why({ source: "acme/x", branch: "a b" })).toMatch(/branch/);
    expect(why({ source: "ext::sh -c touch" })).toMatch(/not a git URL/);
    expect(why({ source: "" })).toMatch(/source/);
  });
});

describe("SRV-P3: the clone", () => {
  it("clones a file:// repo with plain git into the folder, and answers with its path", async () => {
    const t0 = tmp();
    const src = path.join(t0, "src-repo");
    fs.mkdirSync(src);
    const g = (...a: string[]) =>
      execFileSync("git", a, { cwd: src, stdio: "ignore" });
    g("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(src, "README.md"), "hello\n");
    g("add", ".");
    g(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qm",
      "one",
    );
    const root = tmp();
    const t = cloneTarget({ source: `file://${src}`, name: "notes" }, root);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    const out = await runClone(t);
    expect(out).toEqual({ ok: true, path: path.join(root, "notes") });
    expect(
      fs.readFileSync(path.join(root, "notes", "README.md"), "utf-8"),
    ).toBe("hello\n");
  });

  it("gh's credential only for GitHub; git gets the URL after --, never through a shell", async () => {
    const root = tmp();
    const calls: string[][] = [];
    const t = cloneTarget({ source: "acme/notes", branch: "dev" }, root);
    if (!t.ok) throw new Error(t.error);
    await runClone(t, async (args) => {
      calls.push(args);
    });
    expect(calls).toEqual([
      [
        "-c",
        "credential.helper=!gh auth git-credential",
        "clone",
        "--branch",
        "dev",
        "--",
        "https://github.com/acme/notes.git",
        path.join(root, "notes"),
      ],
    ]);
  });

  it("a failed clone answers its first line, with no user info in it", async () => {
    const root = tmp();
    const t = cloneTarget(
      { source: "https://bob:s3cret@git.example.test/team/shop.git" },
      root,
    );
    if (!t.ok) throw new Error(t.error);
    const out = await runClone(t, async () => {
      throw Object.assign(new Error("Command failed"), {
        stderr:
          "fatal: could not read from https://bob:s3cret@git.example.test/team/shop.git\nmore",
      });
    });
    expect(out).toEqual({
      ok: false,
      error:
        "could not clone https://***@git.example.test/team/shop.git: fatal: could not read from https://***@git.example.test/team/shop.git",
    });
  });
});
