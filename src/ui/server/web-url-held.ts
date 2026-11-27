/**
 * Issue 869: the held write web_url_set. Den's own agent proposes this
 * install's address (web.url) when it finds it wrong or missing; the
 * person Allows it in the browser. It writes through the path Settings ›
 * Den's address uses (web-url-routes.ts): the address must answer as this
 * Den through its name (the one-time probe, which only reaches this server
 * when the edge routes the name here), at the ask and again at the Allow.
 * An address that doesn't answer is never written. Saved, it is confirmed
 * and audited, and takes effect without a restart.
 */
import { line, reviewLines } from "../../shared/review-lines.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import { checkWebUrl } from "../../shared/web/web-url-check.js";
import { loopbackRefusal } from "../../shared/web/web-url-check.js";
import type { WebUrl, WebUrlChange } from "../../shared/web/web-url.js";
import type { HeldAction, HeldCheck } from "./approval-routes.js";
import { checkAnswers, type WebUrlRouteDeps } from "./web-url-routes.js";

export const WEB_URL_HELD_PATH = "held write web_url_set";

export interface WebUrlHeldDeps extends Pick<
  WebUrlRouteDeps,
  "ping" | "checkMs"
> {
  read: () => WebUrl | null;
  /** Save it, as Settings does (confirmed, audited, live at once). */
  set: (url: string, how: WebUrlChange) => string;
  /**
   * Whether `host` is this machine (it resolves to one of its own
   * addresses, the mesh's too) or a host Den already serves (the current
   * address, the edge's names). "Answers as this Den" can't tell this Den
   * from a proxy passing requests through to it, so a host that is none of
   * those gets a warning first on the card: every sign-in and link would
   * go through it. Never a refusal (a real tunnel is allowed).
   */
  knownHost?: (host: string) => Promise<boolean>;
}

export function webUrlSetAction(d: WebUrlHeldDeps): HeldAction {
  return {
    async check(a, who): Promise<HeldCheck> {
      if (who?.project && !isServerScope(who.project))
        return {
          ok: false,
          error: `this install's address is the whole Den's: Den's own agent or a person proposes it, not ${who.agent ?? "a project's agent"}`,
        };
      const ok = checkWebUrl(a.url);
      if (!("url" in ok)) return { ok: false, error: ok.error };
      const loop = loopbackRefusal(ok.url);
      if (loop) return { ok: false, error: loop };
      const answers = await checkAnswers(ok.url, d);
      if (!answers.ok)
        return { ok: false, error: `${answers.why}. Nothing changed.` };
      const now = d.read();
      const from = now?.url ?? null;
      return {
        ok: true,
        // The address every link and Hub use: the person's own Allow.
        personOnly: true,
        args: { url: ok.url },
        summary: `make ${ok.url} this Den's address`,
        params: { url: ok.url, from: from ?? "" },
        ...reviewLines([
          ...(d.knownHost && !(await d.knownHost(new URL(ok.url).hostname))
            ? [
                line(
                  `New host: ${new URL(ok.url).hostname} isn't this machine or an address Den serves. Sign-in and every link will go through it.`,
                  "ap.det.web_url_set.newHost",
                  { host: new URL(ok.url).hostname },
                ),
              ]
            : []),
          from
            ? now?.confirmed
              ? line(`Now: ${from}.`, "ap.det.web_url_set.now", { from })
              : line(
                  `Now: ${from} (not confirmed).`,
                  "ap.det.web_url_set.nowUnconfirmed",
                  { from },
                )
            : line("Now: no address is set.", "ap.det.web_url_set.none"),
          line(
            `${ok.url} answers as this Den now: Den asked it for a one-time token, through its name.`,
            "ap.det.web_url_set.answers",
            { url: ok.url },
          ),
          line(
            "Saved as confirmed, the same way Settings saves the address; it takes effect without a restart, and Den tells the connected Hub.",
            "ap.det.web_url_set.saves",
          ),
        ]),
      };
    },
    // The queue checks again first: an address that stopped answering
    // since the ask is refused, and nothing is written.
    run(a, asked) {
      const url = d.set(String(a.url), {
        path: WEB_URL_HELD_PATH,
        ...(asked?.decidedBy ? { who: asked.decidedBy } : {}),
      });
      return Promise.resolve({ ok: true, url, confirmed: true });
    },
  };
}
