import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { hubUrlProblem } from "../../shared/hub.js";

export interface HubSwitch {
  to: string;
  from: string;
  at: string;
}

export const hubSwitchFile = (stateDir: string): string =>
  path.join(stateDir, "hub", "switch.json");

export function readHubSwitch(stateDir: string): HubSwitch | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(hubSwitchFile(stateDir), "utf-8"),
    ) as Record<string, unknown>;
    const { to, from, at } = raw ?? {};
    if (typeof to !== "string" || typeof from !== "string") return null;
    if (typeof at !== "string") return null;
    if (hubUrlProblem(to) || hubUrlProblem(from)) return null;
    return { to, from, at };
  } catch {
    return null;
  }
}

export function saveHubSwitch(stateDir: string, s: HubSwitch): void {
  const f = hubSwitchFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileAtomic(
    f,
    JSON.stringify({ to: s.to, from: s.from, at: s.at }) + "\n",
    { mode: 0o600 },
  );
}

export function clearHubSwitch(stateDir: string): void {
  fs.rmSync(hubSwitchFile(stateDir), { force: true });
}

export const HUB_SWITCH_SUBJECT = "record:hub-switch";
const SETTINGS_HUB = "/settings#agents.hub";

export function switchBell(s: HubSwitch, why?: string) {
  return why
    ? {
        kind: "waiting" as const,
        subject: HUB_SWITCH_SUBJECT,
        scope: "workspace/den-server",
        text: `Den couldn't switch to ${s.to}: ${why}. It stays on ${s.from}; sign in again in Settings › Hub.`,
        msg: {
          key: "bell.m.hubSwitchFailed",
          vars: { to: s.to, from: s.from, why },
        },
        link: SETTINGS_HUB,
      }
    : {
        kind: "waiting" as const,
        subject: HUB_SWITCH_SUBJECT,
        scope: "workspace/den-server",
        text: `Sign in to ${s.to} to finish switching Hubs; Den stays on ${s.from} until then.`,
        msg: { key: "bell.m.hubSwitchWaits", vars: { to: s.to, from: s.from } },
        link: SETTINGS_HUB,
      };
}

type Bell = {
  add: (n: ReturnType<typeof switchBell>) => unknown;
  remove: (m: (n: { subject: string }) => boolean) => number;
};

export function beginHubSwitch(
  d: { stateDir: string; bell: Bell },
  s: HubSwitch,
): void {
  saveHubSwitch(d.stateDir, s);
  d.bell.add(switchBell(s));
}

export function endHubSwitch(
  d: { stateDir: string; bell: Bell },
  r: { ok: boolean; why?: string },
): void {
  const s = readHubSwitch(d.stateDir);
  if (r.ok) {
    clearHubSwitch(d.stateDir);
    d.bell.remove((n) => n.subject === HUB_SWITCH_SUBJECT);
    return;
  }
  if (s) d.bell.add(switchBell(s, r.why || "the sign-in didn't finish"));
}

export async function hubSwitchDeps(): Promise<{
  stateDir: string;
  bell: Bell;
}> {
  const [paths, notes] = await Promise.all([
    import("../../shared/paths.js"),
    import("./notification-service.js"),
  ]);
  return {
    stateDir: paths.getStateDir(),
    bell: notes.notificationDeps().store as unknown as Bell,
  };
}
