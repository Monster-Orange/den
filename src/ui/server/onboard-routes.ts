/**
 * ON-3's read routes (GET only; reads in route-classes.ts):
 *
 *   /api/onboard/status    what's set up and the one next step
 *                          (onboard-reads.ts onboardStatus)
 *   /api/onboard/repos     ?path=<folder>[&max=<n>]: the git repos in a
 *                          folder, how each runs, suggested workspaces
 *   /api/onboard/manifest  ?path=<repo>[&name&run&down&health]: the side-car
 *                          manifest `repo add` would write, validated, and
 *                          nothing written
 *
 * The MCP tools onboard_status, repos_detect and manifest_draft read these,
 * and a page can show them as they are. A path outside the person's home
 * folder, or in Den's state folder, is a 400 with the reason.
 */
import * as http from "http";
import { AUDIT_HEADERS } from "../../shared/agent-actor.js";
import { getStateDir } from "../../shared/paths.js";
import { readWebPort } from "../../shared/edge/config.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { sendJson } from "./http-helpers.js";
import {
  checkOnboardPath,
  manifestDraft,
  onboardStatus,
  processPathRules,
  reposDetect,
  type OnboardStatus,
  type PathRules,
  type RegisteredRepo,
} from "../cli/onboard-reads.js";
import { defaultStatusDeps, registeredRepos } from "../cli/onboard-command.js";
import type { ManifestValidator } from "../cli/repo-command.js";
import { runnableCli } from "../cli/doctor-onboard.js";

export interface OnboardRouteDeps {
  rules: () => PathRules;
  validate: ManifestValidator;
  registered: () => RegisteredRepo[];
  bin: () => string;
  status: (o: { viaMcp: boolean }) => Promise<OnboardStatus>;
}

/** The web server's own deps; `validate` comes from its entry (index.ts). */
export function defaultOnboardRouteDeps(
  validate: ManifestValidator,
  version: string,
): OnboardRouteDeps {
  return {
    rules: () => processPathRules(getStateDir()),
    validate,
    registered: registeredRepos,
    bin: runnableCli,
    status: async ({ viaMcp }) => {
      let port: number;
      try {
        port = readWebPort();
      } catch {
        port = DEFAULT_PORT;
      }
      // This server is the web server asked about: it is answering.
      return onboardStatus(
        await defaultStatusDeps({
          webUrl: `http://localhost:${port}`,
          probeWeb: async () => ({ kind: "up", version }),
          viaMcp,
        }),
      );
    },
  };
}

const param = (url: URL, k: string): string | undefined =>
  url.searchParams.get(k) ?? undefined;

/** Handles the routes above; false when `pathname` is not one of them. */
export async function handleOnboardRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  url: URL,
  deps: OnboardRouteDeps,
): Promise<boolean> {
  if (
    pathname !== "/api/onboard/status" &&
    pathname !== "/api/onboard/repos" &&
    pathname !== "/api/onboard/manifest"
  )
    return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET" });
    res.end("read-only");
    return true;
  }
  try {
    if (pathname === "/api/onboard/status") {
      const viaMcp = req.headers[AUDIT_HEADERS.actor] === "agent";
      sendJson(res, await deps.status({ viaMcp }));
      return true;
    }
    const rules = deps.rules();
    const check = checkOnboardPath(param(url, "path"), rules);
    if (!check.ok) {
      sendJson(res, { ok: false, error: check.error }, 400);
      return true;
    }
    if (pathname === "/api/onboard/repos") {
      const max = Number(param(url, "max"));
      sendJson(
        res,
        reposDetect(check.dir, rules, {
          registered: deps.registered,
          bin: deps.bin(),
          ...(Number.isInteger(max) && max > 0 ? { maxRepos: max } : {}),
        }),
      );
      return true;
    }
    sendJson(
      res,
      manifestDraft(check.dir, rules, deps.validate, {
        name: param(url, "name"),
        run: param(url, "run"),
        down: param(url, "down"),
        health: param(url, "health"),
      }),
    );
  } catch (e) {
    sendJson(res, { ok: false, error: (e as Error).message }, 500);
  }
  return true;
}
