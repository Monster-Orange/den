/**
 * Issue 592: the held write keep_running ({ on }), Keep agents running
 * after logout offered by Den's own server agent instead of found in
 * Settings. The agent proposes it when doctor or onboard_status says agents
 * stop at logout (a login service) and the Setting is unset; once per
 * install (KEEP_PROPOSED_FILE), never when the person turned it off. A
 * project's agent is refused (the MCP tool refuses a scoped server first).
 *
 * The Review says what changes (login → always), that Den restarts and
 * running agents come back, that one admin password is asked, and how
 * agents sign in after logout (the long-lived token; with none set it says
 * so and links Settings › Sign-in token).
 *
 * Run: Settings › Apply's code (keep-running-routes.ts applyKeepRunningMode).
 * The admin password is the Allow's browser's: needsSudo makes the decide
 * answer needs_sudo before anything runs (approval-routes.ts), the page
 * asks with the existing dialog (topbar.js askSudo) and Allows again. The
 * agent never sees it, and the ask's args are { on } only.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import type { ServiceMode } from "../cli/doctor-where.js";
import type { HeldAction, HeldCheck } from "./approval-routes.js";
import {
  applyKeepRunningMode,
  installRunsSudo,
  type KeepRunningCore,
} from "./keep-running-routes.js";
import {
  line,
  reviewLines,
  type ReviewLine,
} from "../../shared/review-lines.js";

/** The server agent proposed it on this install: never again. */
export const KEEP_PROPOSED_FILE = "keep-running-proposed.json";

/** The Review's link to Settings › Sign-in token: its words' key. */
const SIGNIN_LINK_KEY = "ap.link.signinToken";
/** Where the Review's link goes: the Setting, its Sign-in token below it. */
export const KEEP_TOKEN_LINK = "/settings#agents.keep_running";

export interface KeepRunningHeldDeps extends KeepRunningCore {
  /**
   * Whether the agents' long-lived sign-in token is set (null: unknown).
   * Never the token.
   */
  tokenSet: () => Promise<boolean | null>;
  stateDir: () => string;
}

const modeOf = (on: boolean): ServiceMode => (on ? "always" : "login");

export function keepRunningHeld(d: KeepRunningHeldDeps): HeldAction {
  const proposedFile = () => path.join(d.stateDir(), KEEP_PROPOSED_FILE);
  return {
    async check(a, who): Promise<HeldCheck> {
      if (typeof a.on !== "boolean")
        return { ok: false, error: "on is true or false" };
      if (who?.project && !isServerScope(who.project))
        return {
          ok: false,
          error: `how Den runs is the whole install's: Den's own agent asks, not ${who.agent ?? "a project's agent"}`,
        };
      if (d.platform() !== "darwin")
        return {
          ok: false,
          error: "keeping agents running after logout is for macOS (launchd)",
        };
      const installed = d.installed();
      if (installed === null)
        return {
          ok: false,
          error: `Den isn't running as a service yet: ${d.cli} service install first`,
        };
      const on = a.on;
      // An agent only offers to keep agents running; stopping them at
      // logout is the person's own switch (Settings › Agents).
      if (who?.agent && !on)
        return {
          ok: false,
          error:
            "an agent only offers to keep agents running; stopping them at logout is the person's switch in Settings › Agents",
        };
      const mode = modeOf(on);
      if (installed === mode)
        return {
          ok: false,
          error: `Den already runs in ${mode} mode: nothing to switch`,
        };
      // The server agent's offer: once per install, and never against the
      // person's own choice. A person's ask (no agent) is theirs to make.
      if (who?.agent && on) {
        let setting: boolean | undefined;
        try {
          setting = d.current?.();
        } catch {
          setting = undefined;
        }
        if (setting === false)
          return {
            ok: false,
            error:
              "the person turned it off in Settings › Agents › Keep agents running after logout: don't offer it",
          };
        if (fs.existsSync(proposedFile()))
          return {
            ok: false,
            error:
              "already offered once on this install: the person switches it in Settings › Agents › Keep agents running after logout",
          };
      }
      const from = installed;
      const sudo = installRunsSudo(mode, installed);
      const to = mode;
      // Issue 205: each Review line beside its key (review-lines.ts).
      const lines: ReviewLine[] = [
        line(`How Den runs: ${from} → ${to}.`, "ap.det.keep_running.mode", {
          from,
          to,
        }),
        line(
          "Den restarts; running agents come back where they were.",
          "ap.det.keep_running.restart",
        ),
      ];
      if (sudo)
        lines.push(
          line(
            "The admin password is asked once, in this browser, when you Allow. The agent never sees it.",
            "ap.det.keep_running.sudo",
          ),
        );
      let link: { href: string; key: string } | undefined;
      if (on) {
        let token: boolean | null;
        try {
          token = await d.tokenSet();
        } catch {
          token = null;
        }
        if (token === false) {
          lines.push(
            line(
              "No sign-in token is set: agents won't be able to sign in after you log out. Set one in Settings › Agents › Sign-in token.",
              "ap.det.keep_running.noToken",
            ),
          );
          // A link under the lines, not a line: its own words' key.
          link = { href: KEEP_TOKEN_LINK, key: SIGNIN_LINK_KEY };
        } else
          lines.push(
            line(
              "After logout, agents sign in with the long-lived token in Settings › Agents › Sign-in token.",
              "ap.det.keep_running.token",
            ),
          );
      }
      if (who?.agent && on)
        try {
          fs.mkdirSync(d.stateDir(), { recursive: true, mode: 0o700 });
          writeFileAtomic(
            proposedFile(),
            JSON.stringify({
              proposedAt: new Date().toISOString(),
              by: who.agent,
            }) + "\n",
            { mode: 0o600 },
          );
        } catch {
          /* asked again later: better than never */
        }
      return {
        ok: true,
        // It changes how Den runs and asks for sudo: the person's own.
        personOnly: true,
        args: { on },
        summary: on
          ? "keep agents running after logout"
          : "stop agents when you log out",
        params: { from, to },
        ...reviewLines(lines),
        ...(link ? { link } : {}),
      };
    },
    needsSudo(a) {
      if (typeof a.on !== "boolean") return null;
      const mode = modeOf(a.on);
      const installed = d.installed();
      if (installed === null || installed === mode) return null;
      return installRunsSudo(mode, installed) && !d.sudoReady()
        ? { command: `${d.cli} service install --mode ${mode}` }
        : null;
    },
    async run(a) {
      const r = await applyKeepRunningMode(a.on === true, d);
      // The password held at the Allow has lapsed since: say so plainly.
      if (r.body.ok === false && r.body.needsSudo)
        return {
          ...r.body,
          error:
            "The admin password is no longer held, so nothing ran. Allow again, and this browser asks for it.",
        };
      // Applied: Den re-installs its jobs and restarts; the page waits.
      return r.body.ok === true && r.body.applied === true
        ? { ...r.body, restarting: true }
        : r.body;
    },
  };
}
