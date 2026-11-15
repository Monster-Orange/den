/**
 * SRV-P3 (0.4.48): repo_clone, an agent's held ask to clone a repo into
 * the folder Den finds repos in (repos_root), for manifest_draft and
 * repo_add (each its own Allow) to take up.
 *
 * A GitHub repo (owner/name, or a github.com URL) is cloned with the
 * person's gh login as credential helper; any other remote with plain git
 * and the person's own credentials, never gh's (SEC-0). The check touches
 * no network and writes nothing. The clone runs git without a shell, the
 * URL after `--`, and a remote's user info is never shown.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  isSafeRemote,
  redactRemote,
  SAFE_SLUG_RE,
} from "./environment-manager/git-remote.js";

export interface CloneAsk {
  /** owner/name (GitHub), or a git URL. */
  source: string;
  /** The folder's name under repos_root (default: the repo's). */
  name?: string;
  /** The branch to check out (default: the remote's). */
  branch?: string;
}

export type CloneTarget =
  | {
      ok: true;
      url: string;
      /** The source as the person reads it: user info masked. */
      shown: string;
      name: string;
      dest: string;
      /** Clone with the person's gh login (GitHub only). */
      gh: boolean;
      branch?: string;
    }
  | { ok: false; error: string };

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** A URL with a transport, or scp-style git@host:path; never a bare path. */
const URL_LIKE_RE = /^(?:[a-z+]+:\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:)/;

/** What repo_clone would clone, and where; refused in plain words. */
export function cloneTarget(a: CloneAsk, reposRoot: string): CloneTarget {
  const no = (error: string): CloneTarget => ({ ok: false, error });
  const source = typeof a.source === "string" ? a.source.trim() : "";
  if (!source)
    return no("give source: owner/name (GitHub) or the repo's git URL");
  let url: string;
  let gh: boolean;
  if (SAFE_SLUG_RE.test(source)) {
    url = `https://github.com/${source.replace(/\.git$/, "")}.git`;
    gh = true;
  } else if (source.startsWith("/") || source.startsWith("~")) {
    return no(
      `${source} is a local folder: repo_add takes a local folder as it is, with no clone`,
    );
  } else if (URL_LIKE_RE.test(source) && isSafeRemote(source)) {
    url = source;
    gh = GITHUB_URL_RE.test(source.replace(/\.git$/, ""));
  } else {
    return no(
      `${redactRemote(source)} is not a git URL Den can clone (owner/name, https://, ssh://, git://, file://, git@host:path)`,
    );
  }
  const leaf =
    url
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop() ?? "";
  const name = a.name?.trim() || leaf;
  if (!NAME_RE.test(name))
    return no(
      `name "${name}" must be one folder name: letters, digits, ".", "_" and "-"`,
    );
  const branch = a.branch?.trim() || undefined;
  if (
    branch !== undefined &&
    (!BRANCH_RE.test(branch) || branch.startsWith("-"))
  )
    return no(
      `branch "${branch}" may have only letters, digits, ".", "_", "/" and "-"`,
    );
  const dest = path.join(path.resolve(reposRoot), name);
  if (fs.existsSync(dest))
    return no(
      `there is already a folder at ${dest}: repo_add it instead, or give another name`,
    );
  return {
    ok: true,
    url,
    shown: SAFE_SLUG_RE.test(source) ? source : redactRemote(source),
    name,
    dest,
    gh,
    ...(branch ? { branch } : {}),
  };
}

/** Runs git with these arguments (no shell). */
export type GitRunner = (args: string[]) => Promise<unknown>;

const gitRun: GitRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr })) : resolve(stdout),
    );
  });

/** Clones `t`; answers its folder, or why not (first line, user info masked). */
export async function runClone(
  t: Extract<CloneTarget, { ok: true }>,
  run: GitRunner = gitRun,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  const args = [
    ...(t.gh ? ["-c", "credential.helper=!gh auth git-credential"] : []),
    "clone",
    ...(t.branch ? ["--branch", t.branch] : []),
    "--",
    t.url,
    t.dest,
  ];
  try {
    fs.mkdirSync(path.dirname(t.dest), { recursive: true });
    await run(args);
    return { ok: true, path: t.dest };
  } catch (e) {
    const err = e as Error & { stderr?: unknown };
    const said =
      (typeof err.stderr === "string" && err.stderr.trim()) || err.message;
    const first = said
      .split("\n")[0]
      .replace(/[a-z+]+:\/\/[^@/\s]+@/gi, (m) =>
        m.replace(/\/\/[^@/]+@/, "//***@"),
      );
    return { ok: false, error: `could not clone ${t.shown}: ${first}` };
  }
}
