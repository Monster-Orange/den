/**
 * Issue 726: changing a Den's Hub is one clean step, whatever changed
 * hub.url: Settings › Hub, POST /api/settings, the hub_connect held write,
 * or a config edit (noticed at start).
 *
 *   - The old token is revoked on the Hub that issued it and removed here
 *     (Connect's own file or store item). One that Hub couldn't hear is
 *     kept on record (hub-binding.ts recordUnrevoked): doctor lists it, and
 *     each start tries the revoke again until that Hub answers.
 *   - The Hub state is archived (hub-binding.ts bindHub): the delivery
 *     seen-store, the inbox watch, the tools and links seen, and every
 *     project's link. The running loops drop what they hold in memory
 *     first, so nothing from the old Hub is typed or reported to the new one.
 *   - The old Hub's bell items go, and the projects that had a link are
 *     offered again: "N projects need your pick" (Connect links the clear
 *     ones and counts the rest).
 */
import {
  bindHub,
  decideHubBinding,
  dropUnrevoked,
  hubOrigin,
  readHubBinding,
  readUnrevoked,
  recordUnrevoked,
  unrevokedToken,
  type ArchivedHub,
  type HubNow,
} from "../../shared/hub-binding.js";
import { forgetHubToken, type HubConfig } from "../../shared/hub.js";
import type {
  Notification,
  NotificationStore,
} from "../../shared/notifications.js";
import type { WorkspacesFile } from "../../shared/types/index.js";
import { pickNote } from "./hub-link-all-routes.js";

export interface HubChangeDeps {
  stateDir: () => string;
  now?: () => Date;
  readWorkspaces: () => WorkspacesFile;
  writeWorkspaces: (f: WorkspacesFile, by: string) => void;
  bell: () => Pick<NotificationStore, "remove" | "add">;
  /** Stop the delivery, inbox and tools loops and drop what they hold. */
  stopLoops: () => Promise<void>;
  audit: (detail: string) => void;
  readToken: (cfg: HubConfig) => Promise<string | null>;
  revoke: (url: string, token: string) => Promise<boolean>;
  /** Remove a token Connect stored (its file or store item). */
  forget: (cfg: HubConfig) => Promise<void>;
  /** Whether `cfg`'s token is one Connect stored (Den's to drop). */
  owns: (cfg: HubConfig) => boolean;
  config: () => HubConfig | null;
  readUser: () => Record<string, unknown>;
  writeUser: (u: Record<string, unknown>) => void;
}

/** Where a person picks after a change: Settings › Hub, to Connect first. */
export const HUB_CHANGE_PICK_LINK = "/settings#agents.hub";

const HUB_KEYS = new Set([
  "bell.m.hub",
  "bell.m.hubOn",
  "bell.m.hubNoAnswer",
  "bell.m.notAtPrompt",
]);

/** A bell item about Hub: Hub's own, or Den's about Hub's comments. */
export function isHubBellItem(n: Notification): boolean {
  if (n.source === "hub") return true;
  if (n.subject.startsWith("record:hub-")) return true;
  if (n.subject.startsWith("record:not-at-prompt:")) return true;
  const k = n.msg?.key ?? "";
  return HUB_KEYS.has(k) || k.startsWith("bell.m.held.");
}

const hubWords = (
  b: { origin?: string; url?: string | null; company?: string } | null,
) =>
  b
    ? `${b.origin || hubOrigin(b.url ?? "") || "none"}${b.company ? ` (${b.company})` : ""}`
    : "none";

/**
 * The Hub is now `now`: bind its state, or archive the old Hub's and start
 * fresh. `cleared`: no Hub now; the state stays (the same Hub again loses
 * nothing), the bell's Hub items go.
 */
export async function noteHub(
  d: HubChangeDeps,
  now: HubNow,
): Promise<{
  kind: "same" | "bind" | "change" | "cleared";
  archived?: ArchivedHub;
  repick: number;
}> {
  const stateDir = d.stateDir();
  const bound = readHubBinding(stateDir);
  if (!now.url) {
    if (!bound) return { kind: "same", repick: 0 };
    d.bell().remove(isHubBellItem);
    return { kind: "cleared", repick: 0 };
  }
  const kind = decideHubBinding(bound, now);
  if (kind === "same") return { kind, repick: 0 };
  if (kind === "change") await d.stopLoops();
  const r = bindHub(
    {
      stateDir,
      now: d.now,
      readWorkspaces: d.readWorkspaces,
      writeWorkspaces: d.writeWorkspaces,
    },
    now,
  );
  if (r.kind !== "change" || !r.archived) return { kind: r.kind, repick: 0 };
  const store = d.bell();
  store.remove(isHubBellItem);
  const repick = r.archived.projects.length;
  if (repick) store.add({ ...pickNote(repick), link: HUB_CHANGE_PICK_LINK });
  d.audit(
    `Hub changed: ${hubWords(bound)} → ${hubWords({ url: now.url, company: now.company })}; its state is archived in ${r.archived.dir}; ${repick} project${repick === 1 ? "" : "s"} unlinked, to pick again`,
  );
  return { kind: "change", archived: r.archived, repick };
}

/**
 * Revoke `cfg`'s token on the Hub that issued it, then remove it here.
 * Hub didn't hear it: removed here anyway, and kept on record (doctor, and
 * a retry at each start). Hub had already revoked it: done.
 */
export async function retireHubToken(
  d: Pick<
    HubChangeDeps,
    "stateDir" | "readToken" | "revoke" | "forget" | "now"
  >,
  cfg: HubConfig,
): Promise<{ revoked: boolean; recorded: boolean }> {
  let token: string | null = null;
  let revoked = false;
  let recorded = false;
  try {
    token = await d.readToken(cfg);
  } catch {
    token = null;
  }
  if (token) {
    try {
      revoked = await d.revoke(cfg.url, token);
    } catch (e) {
      recordUnrevoked(
        d.stateDir(),
        { url: cfg.url, why: (e as Error).message, token },
        d.now?.(),
      );
      recorded = true;
    }
  }
  await d.forget(cfg).catch(() => undefined);
  forgetHubToken(undefined, Date.now(), { now: true });
  return { revoked, recorded };
}

/** Try each kept revoke again; how many that Hub now revoked (or had). */
export async function retryUnrevoked(
  d: Pick<HubChangeDeps, "stateDir" | "revoke">,
): Promise<number> {
  const stateDir = d.stateDir();
  let n = 0;
  for (const u of readUnrevoked(stateDir)) {
    const token = unrevokedToken(stateDir, u.id);
    try {
      if (token) await d.revoke(u.url, token);
    } catch {
      continue; // still unreachable: kept, doctor still says so
    }
    dropUnrevoked(stateDir, u.id);
    n++;
  }
  return n;
}

const hasToken = (c: HubConfig | null): c is HubConfig =>
  !!c && !!(c.tokenRef || c.tokenSource);

/**
 * POST /api/settings saved hub.url (Settings › Hub, or a bare API call):
 * the token `before` names, when it's still there and for another Hub, is
 * revoked and removed; then the state follows the new Hub.
 */
export async function hubUrlSaved(
  d: HubChangeDeps,
  before: HubConfig | null,
  url: string | null,
): Promise<void> {
  const was = before ? hubOrigin(before.url) : "";
  const moved = was !== (url ? hubOrigin(url) : "");
  if (moved && hasToken(before)) await retireHubToken(d, before);
  if (moved) await noteHub(d, { url });
}

/**
 * At start, before the Hub loops: a hub.url edited in the config file to
 * another Hub is a change. Den's own token (Connect's) is the old Hub's:
 * revoked there and dropped here, so it never goes to the new one. A token
 * the distribution set is left as it is. Then the earlier revokes that
 * failed are tried again.
 */
export async function hubChangeAtStart(
  d: HubChangeDeps,
): Promise<{ kind: string }> {
  let cfg: HubConfig | null = null;
  try {
    cfg = d.config();
  } catch {
    cfg = null;
  }
  const stateDir = d.stateDir();
  const bound = readHubBinding(stateDir);
  let kind = "same";
  if (cfg?.url) {
    if (
      bound &&
      decideHubBinding(bound, { url: cfg.url }) === "change" &&
      hasToken(cfg) &&
      d.owns(cfg)
    ) {
      await retireHubToken(d, { ...cfg, url: bound.url });
      const user = d.readUser();
      const hub = { ...((user.hub as Record<string, unknown>) ?? {}) };
      delete hub.token;
      delete hub.mcp_url;
      user.hub = hub;
      d.writeUser(user);
    }
    kind = (await noteHub(d, { url: cfg.url })).kind;
  }
  await retryUnrevoked(d).catch(() => 0);
  return { kind };
}

/** The server's own: its state dir, workspaces, bell, loops and Hub. */
export async function defaultHubChangeDeps(): Promise<HubChangeDeps> {
  const [paths, wsm, hub, connect, audit, notes, cfg] = await Promise.all([
    import("../../shared/paths.js"),
    import("../../shared/environment-manager/workspaces.js"),
    import("../../shared/hub.js"),
    import("./hub-connect.js"),
    import("./audit.js"),
    import("./notification-service.js"),
    import("../../shared/den-config.js"),
  ]);
  const cd = connect.defaultHubConnectDeps();
  const rotation = connect.hubTokenRotation();
  return {
    stateDir: () => paths.getStateDir(),
    readWorkspaces: () => wsm.readWorkspacesFile(),
    writeWorkspaces: (f, by) => wsm.writeWorkspacesFile(f, by),
    bell: () => notes.notificationDeps().store,
    stopLoops: async () => {
      const [dl, tools] = await Promise.all([
        import("./hub-delivery-service.js"),
        import("./hub-tools-service.js"),
      ]);
      dl.dropDeliveryState();
      tools.dropToolsWatch();
    },
    audit: (detail) =>
      audit.recordAction(null, {
        verb: "hub-change",
        detail: detail.slice(0, 400),
      }),
    readToken: cd.readToken,
    revoke: (url, token) => hub.hubRevoke(url, token),
    forget: cd.forget,
    owns: (c) => rotation.owns(c),
    config: () => hub.readHubConfig(),
    readUser: () =>
      structuredClone(cfg.readUserConfig()) as Record<string, unknown>,
    writeUser: (u) => cfg.writeUserConfig(u as never),
  };
}
