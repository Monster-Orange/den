/**
 * doctor's owner check (D17): who can connect their GitHub account to this
 * instance from the browser.
 *
 *  - An owner is linked: ok, naming it.
 *  - No owner, but web.owner_github or web.allowed_github_org says who may
 *    claim it: ok, naming them.
 *  - Neither, and the edge is reachable from other machines: ✗ (a fail):
 *    nobody can get in from a browser there, and the page can only name
 *    the settings.
 *  - Neither, edge not reachable beyond this machine: a warning.
 */
import { readWebOwner } from "../../shared/web-owner.js";
import {
  readWebAuthConfig,
  type WebAuthConfig,
} from "../../shared/web-session.js";
import { getDistRoot, getStateDir } from "../../shared/paths.js";
import { product } from "../../shared/product.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import { edgeNames, webRouteHosts } from "../../shared/edge/render.js";
import { edgeExposure } from "../../shared/edge/exposure.js";
import type { OnboardCheck } from "./doctor-onboard.js";
import { ghLogin, ghNotSignedInHint } from "../../shared/owner-github.js";

export interface OwnerCheckDeps {
  owner?: () => { login: string } | null;
  web?: () => WebAuthConfig;
  /** Why the edge is reachable beyond this machine, or null. */
  exposed?: () => Promise<string | null>;
  configFile?: string;
  /** The login gh is signed in as here, or null (default: ask gh). */
  ghLogin?: () => string | null;
}

/**
 * What to do when web.owner_github isn't set: gh is signed in but nothing
 * recorded it yet (a restart does), or gh isn't signed in.
 */
export function ownerGithubHint(login: string | null, cli: string): string {
  return login
    ? `gh is signed in as @${login}: run \`${cli} web restart\` to record it as this Den's owner (web.owner_github), then connect your GitHub account from any browser.`
    : ghNotSignedInHint(cli);
}

async function defaultExposed(): Promise<string | null> {
  try {
    const cfg = readEdgeConfig();
    const hosts = webRouteHosts(cfg, new Set([readWebPort()])).map(
      (r) => r.host,
    );
    return await edgeExposure(
      hosts,
      cfg.ports ? edgeNames(cfg.org).container : null,
    );
  } catch {
    return null; // no edge
  }
}

export async function ownerCheck(
  deps: OwnerCheckDeps = {},
): Promise<OnboardCheck> {
  const owner = (deps.owner ?? (() => readWebOwner(getStateDir())))();
  if (owner)
    return {
      id: "web:owner",
      status: "ok",
      detail: `owner: @${owner.login} (linked; Sign in with GitHub from any browser)`,
    };
  let web: WebAuthConfig;
  try {
    web = (
      deps.web ?? (() => readWebAuthConfig(getDistRoot(), product().configFile))
    )();
  } catch (e) {
    return { id: "web:owner", status: "fail", detail: (e as Error).message };
  }
  const configFile = deps.configFile ?? product().configFile;
  const who = [
    ...(web.ownerGithub
      ? [`@${web.ownerGithub} from any browser (web.owner_github)`]
      : []),
    ...(web.allowedGithubOrg
      ? [
          `a member of ${web.allowedGithubOrg} on this computer (web.allowed_github_org)`,
        ]
      : []),
  ];
  // D17: owner_github carries most people (org memberships are usually
  // private); without it, say how to get it.
  const ghHint = web.ownerGithub
    ? {}
    : { ask: ownerGithubHint((deps.ghLogin ?? ghLogin)(), product().cli) };
  if (who.length)
    return {
      id: "web:owner",
      status: "ok",
      detail: `no owner yet; who may connect GitHub to claim it: ${who.join(", or ")}`,
      ...ghHint,
    };
  const exposed = await (deps.exposed ?? defaultExposed)();
  // Only this machine reaches it: a note, not a warning (every fresh
  // install starts this way, D12).
  return {
    id: "web:owner",
    status: exposed ? "fail" : "ok",
    detail:
      `no owner, and nothing says who may claim it, so nobody can connect GitHub from the browser` +
      (exposed
        ? `; the edge is reachable from other machines (${exposed})`
        : ""),
    ask: `Which GitHub org's members may claim it (web.allowed_github_org in ${configFile}), or which GitHub login runs it here (web.owner_github in config/local/user.yml)?`,
  };
}

/** The check as doctor prints it. */
export function ownerLine(c: OnboardCheck): string {
  const mark =
    c.status === "fail" ? "✗" : c.status === "warn" ? "⚠" : c.ask ? "ℹ" : "✓";
  return `  ${mark} ${c.detail}${c.ask ? `\n    ${c.ask}` : ""}`;
}
