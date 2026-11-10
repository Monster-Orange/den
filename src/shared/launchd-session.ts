/**
 * D20: the launchd session a process runs in, as `launchctl managername`
 * names it. It decides what survives a logout:
 *
 *   Aqua, LoginWindow  the desktop login session (gui/<uid>): ends when the
 *                      person logs out, with every process in it.
 *   Background         outside it (an ssh shell, user/<uid>): keeps running
 *                      after logout, but has no login keychain and no GUI
 *                      (headed apps, WebKit on macOS).
 *   System             a LaunchDaemon: as Background.
 *
 * A child inherits its parent's session, so a session host started from
 * the desktop dies at logout with every agent in it. Off macOS there is no
 * such thing (null).
 */
import { spawnSync } from "child_process";

/**
 * `service install --mode always` is opt-in: it is meant to keep the
 * server, the host and every agent running across a logout, but no logout
 * has proven it yet. Every place that offers it says so.
 */
export const ALWAYS_UNPROVEN = "not yet proven across a logout";

export type LaunchctlRunner = () => { status: number | null; stdout: string };

const defaultRunner: LaunchctlRunner = () => {
  const r = spawnSync("launchctl", ["managername"], {
    encoding: "utf-8",
    timeout: 2000,
  });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/** `launchctl managername`, or "unknown"; null off macOS. */
export function readLaunchdSession(
  run: LaunchctlRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== "darwin") return null;
  try {
    const r = run();
    const name = r.status === 0 ? r.stdout.trim() : "";
    // Only a plain word: it is shown and stored as-is.
    return /^[A-Za-z]{1,32}$/.test(name) ? name : "unknown";
  } catch {
    return "unknown";
  }
}

let cached: string | null | undefined;

/** This process's launchd session (it never changes, so asked once). */
export function launchdSession(): string | null {
  if (cached === undefined) cached = readLaunchdSession();
  return cached;
}

/**
 * D20: `web up` from a shell outside the desktop session (an ssh shell:
 * Background) starts a server there; say what that means and the right
 * way. null in the desktop session or off macOS.
 */
export function webUpWarning(
  session: string | null | undefined,
  cli: string,
): string | null {
  if (session !== "Background" && session !== "System") return null;
  return `this shell runs outside the desktop session (${session}, e.g. ssh): a server started here keeps running after logout but has no login keychain and no GUI, and its agents run here too. To run it as a service: ${cli} service install --mode always (opt-in, ${ALWAYS_UNPROVEN}) or --mode login`;
}

/** Whether a process in this session ends when the person logs out. */
export function endsAtLogout(session: string | null | undefined): boolean {
  return session === "Aqua" || session === "LoginWindow";
}

/**
 * The line doctor and the agent page show for `what` (the server, the
 * session host, an agent) running in `session`: the fix when it ends at
 * logout, what it lacks when it doesn't. null when there is nothing to say.
 */
export function sessionWarning(
  session: string | null | undefined,
  cli: string,
  what: string,
): string | null {
  if (endsAtLogout(session))
    return `the ${what} runs in the desktop login session (${session}): it stops when you log out. To keep it running: ${cli} service install --mode always (opt-in, ${ALWAYS_UNPROVEN})`;
  if (session === "Background" || session === "System")
    return `the ${what} keeps running after logout (${session}); it has no login keychain and no GUI, so it uses the 1Password service-account token, headless browsers and Full Disk Access instead`;
  return null;
}
