/**
 * SEC-2a: the owner's GitHub identity. `<state dir>/web-owner.json`, mode
 * 0600: `{ v: 1, owner: "github:<numeric id>", login, name?, linkedAt }`.
 * The id is what sign-in compares; the login and the display name are for
 * display only (a login can be renamed, the id can't). No token is ever stored: the device flow's token
 * is dropped right after `GET /user`.
 *
 * Written by `<cli> web owner link` and Settings › Access; removed by
 * `web owner unlink`. Re-read whenever it changes on disk.
 */
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { getStateDir } from "./paths.js";

export const WEB_OWNER_FILE = "web-owner.json";

export interface WebOwner {
  /** `github:<numeric id>`. */
  owner: `github:${number}`;
  /** The GitHub login at link time, for display. */
  login: string;
  /** The person's GitHub display name, when known (the account entry). */
  name?: string;
  /** ISO time it was linked. */
  linkedAt: string;
}

export function webOwnerPath(stateDir: string = getStateDir()): string {
  return path.join(stateDir, WEB_OWNER_FILE);
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** The longest display name kept (GitHub's own limit is 255). */
const NAME_MAX = 100;

/**
 * A GitHub display name (`/user`'s `.name`) as Den keeps it: trimmed, no
 * control characters, runs of spaces as one, at most 100 characters; undefined when there is none.
 */
export function githubDisplayName(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
  return s ? Array.from(s).slice(0, NAME_MAX).join("") : undefined;
}

/** The linked owner, or null (none, or a file that isn't one). */
export function readWebOwner(
  stateDir: string = getStateDir(),
): WebOwner | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(webOwnerPath(stateDir), "utf-8"));
  } catch {
    return null;
  }
  const o = raw as Partial<WebOwner> | null;
  if (
    !o ||
    typeof o.owner !== "string" ||
    !/^github:[1-9][0-9]{0,15}$/.test(o.owner) ||
    typeof o.login !== "string" ||
    !LOGIN.test(o.login)
  )
    return null;
  const name = githubDisplayName(o.name);
  return {
    owner: o.owner,
    login: o.login,
    ...(name ? { name } : {}),
    linkedAt: typeof o.linkedAt === "string" ? o.linkedAt : "",
  };
}

/** Link `id` (`login` and `name` for display) as the owner: atomic, 0600. */
export function writeWebOwner(
  identity: { id: number; login: string; name?: string },
  stateDir: string = getStateDir(),
  now: Date = new Date(),
): WebOwner {
  if (!Number.isSafeInteger(identity.id) || identity.id <= 0)
    throw new Error("a GitHub account id is a positive integer");
  if (!LOGIN.test(identity.login))
    throw new Error("that is not a GitHub login");
  const name = githubDisplayName(identity.name);
  return saveWebOwner(
    {
      owner: `github:${identity.id}`,
      login: identity.login,
      ...(name ? { name } : {}),
      linkedAt: now.toISOString(),
    },
    stateDir,
  );
}

/**
 * The linked owner's display name, when `login` is still theirs (gh's
 * answer at `web up`, for an owner linked before names were kept). The
 * owner, or null when none is linked or it is another login.
 */
export function setWebOwnerName(
  login: string,
  name: string,
  stateDir: string = getStateDir(),
): WebOwner | null {
  const was = readWebOwner(stateDir);
  const n = githubDisplayName(name);
  if (!was || !n || was.login.toLowerCase() !== login.toLowerCase())
    return null;
  if (was.name === n) return was;
  return saveWebOwner({ ...was, name: n }, stateDir);
}

/**
 * Issue 406: GitHub's answer for the linked owner (account `id`), at a
 * GitHub sign-in: its display name kept, or forgotten when GitHub has none
 * now. The owner, or null when none is linked or `id` isn't theirs.
 */
export function syncWebOwnerName(
  id: number,
  name: string | undefined,
  stateDir: string = getStateDir(),
): WebOwner | null {
  const was = readWebOwner(stateDir);
  if (!was || was.owner !== `github:${id}`) return null;
  const n = githubDisplayName(name);
  if (was.name === n) return was;
  const rec: WebOwner = {
    owner: was.owner,
    login: was.login,
    ...(n ? { name: n } : {}),
    linkedAt: was.linkedAt,
  };
  return saveWebOwner(rec, stateDir);
}

function saveWebOwner(rec: WebOwner, stateDir: string): WebOwner {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = webOwnerPath(stateDir);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, ...rec })}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  return rec;
}

/** Unlink the owner; the one it was, or null when none was linked. */
export function clearWebOwner(
  stateDir: string = getStateDir(),
): WebOwner | null {
  const was = readWebOwner(stateDir);
  fs.rmSync(webOwnerPath(stateDir), { force: true });
  return was;
}
