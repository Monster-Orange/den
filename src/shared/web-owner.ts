/**
 * SEC-2a: the owner's GitHub identity. `<state dir>/web-owner.json`, mode
 * 0600: `{ v: 1, owner: "github:<numeric id>", login, linkedAt }`. The id
 * is what sign-in compares; the login is for display only (a login can be
 * renamed, the id can't). No token is ever stored: the device flow's token
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
  /** ISO time it was linked. */
  linkedAt: string;
}

export function webOwnerPath(stateDir: string = getStateDir()): string {
  return path.join(stateDir, WEB_OWNER_FILE);
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

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
  return {
    owner: o.owner,
    login: o.login,
    linkedAt: typeof o.linkedAt === "string" ? o.linkedAt : "",
  };
}

/** Link `id` (`login` for display) as the owner: atomic, 0600. */
export function writeWebOwner(
  identity: { id: number; login: string },
  stateDir: string = getStateDir(),
  now: Date = new Date(),
): WebOwner {
  if (!Number.isSafeInteger(identity.id) || identity.id <= 0)
    throw new Error("a GitHub account id is a positive integer");
  if (!LOGIN.test(identity.login))
    throw new Error("that is not a GitHub login");
  const rec: WebOwner = {
    owner: `github:${identity.id}`,
    login: identity.login,
    linkedAt: now.toISOString(),
  };
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
