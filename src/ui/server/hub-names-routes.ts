/**
 * Issue 167 (mock v6 A6): /api/hub/names-check, for Settings › Project
 * setup › Name when Hub can't be reached.
 *
 *   GET  → { okAt?, failAt? }: when Hub last answered Den's check of its
 *          project names, and when it last didn't. Nothing is asked of Hub.
 *   POST → Try again: checks Hub's names now (refreshHubNamesNow), then
 *          answers the same. A refresh that fails is in failAt.
 */
import type * as http from "http";
import type { HubNamesCheck } from "../../shared/hub-project-names.js";
import { sendJson } from "./http-helpers.js";

export const HUB_NAMES_PATH = "/api/hub/names-check";

export interface HubNamesRouteDeps {
  read: () => HubNamesCheck;
  refresh: () => Promise<unknown>;
}

export async function hubNamesRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: HubNamesRouteDeps,
): Promise<true> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "POST") {
    await d.refresh().catch(() => undefined);
  } else if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, POST");
    sendJson(res, { ok: false, error: "use GET or POST" }, 405);
    return true;
  }
  sendJson(res, { ok: true, ...d.read() });
  return true;
}

/** The deps on this install: the state folder's record, and the check. */
export async function defaultHubNamesDeps(): Promise<HubNamesRouteDeps> {
  const [names, paths] = await Promise.all([
    import("../../shared/hub-project-names.js"),
    import("../../shared/paths.js"),
  ]);
  return {
    read: () => names.readHubNamesCheck(paths.getStateDir()),
    refresh: async () =>
      (await import("./hub-sync-service.js")).refreshHubNamesNow(),
  };
}
