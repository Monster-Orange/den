/**
 * NT: `<cli> notifications [list|read|clear]`, the bell from a shell. It
 * reads and changes the same store as the bell (<state>/notifications.json,
 * read fresh on every call), so no server is needed.
 *   list [--json]                 by project, then agent; ● unread, ○ read.
 *   read [<id> | -p <project>]    mark read (default: all).
 *   clear [-p <project>]          drop the read ones.
 * Inside an agent's session only list runs: the bell is the person's to
 * change.
 */
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import {
  groupNotifications,
  NotificationStore,
  type Which,
} from "../../shared/notifications.js";
import { product } from "../../shared/product.js";

export const NOTIFICATIONS_HELP = {
  usage: "notifications [list|read|clear]",
  lines: [
    "The bell from a shell: what needs you, by project, then agent.",
    "  list [--json]               ● unread, ○ read (the default)",
    "  read [<id> | -p <project>]  mark read (default: all)",
    "  clear [-p <project>]        drop the read ones",
  ],
};

export interface NotificationsDeps {
  stateDir?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function ago(iso: string, now: number): string {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "now";
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : iso.slice(0, 10);
}

/**
 * A group's heading, as the bell says it: "<title> agent", a project, or
 * "Hub · <project>" (the name Hub gives it, else its slug).
 */
function scopeLabel(scope: string, name = ""): string {
  if (scope === "workspace/den-server") return `${product().title} agent`;
  if (scope.startsWith("workspace/")) return scope.slice("workspace/".length);
  if (scope.startsWith("hub/")) {
    const project = name || scope.slice("hub/".length).split("/")[0];
    return project ? `Hub · ${project}` : "Hub";
  }
  return scope;
}

export async function cmdNotifications(
  args: readonly string[],
  deps: NotificationsDeps = {},
): Promise<number> {
  const cli = product().cli;
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const stateDir =
    deps.stateDir ?? (await import("../../shared/paths.js")).getStateDir();
  const store = new NotificationStore(stateDir, () => new Date(now()));
  const usage = () => {
    err(`usage: ${cli} ${NOTIFICATIONS_HELP.usage}`);
    for (const l of NOTIFICATIONS_HELP.lines) err(l);
    return 2;
  };
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  if (sub === "list") {
    const json = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) return usage();
    const items = store.list();
    const unread = items.filter((n) => !n.read).length;
    const groups = groupNotifications(items);
    if (json) {
      out(JSON.stringify({ unread, groups, mutes: store.mutes() }, null, 2));
      return 0;
    }
    if (!items.length) {
      out("No notifications.");
      return 0;
    }
    out(`${unread} unread`);
    out("");
    for (const g of groups) {
      const name =
        g.subjects.flatMap((x) => x.items).find((n) => n.scopeName)
          ?.scopeName ?? "";
      out(scopeLabel(g.scope, name));
      for (const s of g.subjects)
        for (const n of s.items)
          out(`  ${n.read ? "○" : "●"} ${n.text} · ${ago(n.at, now())}`);
    }
    return 0;
  }

  if (sub !== "read" && sub !== "clear") return usage();
  if (isAgentTokenEnv(env)) {
    err(
      `${cli} notifications ${sub}: the bell is the person's to change; an agent reads it (list).`,
    );
    return 1;
  }
  let which: Which = { all: true };
  if (rest[0] === "-p" || rest[0] === "--project") {
    if (!rest[1] || rest.length > 2) return usage();
    which = { scope: `workspace/${rest[1]}` };
  } else if (rest.length === 1 && sub === "read") {
    which = { id: rest[0] };
  } else if (rest.length) return usage();
  if (sub === "read") {
    out(`Marked ${store.markRead(which)} read.`);
  } else {
    out(`Cleared ${store.clearRead(which)}.`);
  }
  return 0;
}
