/**
 * Issue 868: what the signed-out page says about the ways in this install
 * has set up, so a person on another computer isn't left with only a
 * command they can't run there.
 *
 *   github    Sign in with GitHub: `ready` when it works from anywhere (an
 *             owner is linked, or one GitHub account is named to claim
 *             it); `no_client_id` when no GitHub App client id is set
 *             (`setting` names it); `no_owner` when nobody can use it yet
 *             (no owner linked, or only a GitHub org that claims it from
 *             the host itself)
 *   browser   a person's browser is signed in, so it can approve this one
 *             by typing the code this page shows (issue 819)
 *   terminal  the command that prints a sign-in link, run on the host
 *   remote    the request came from another computer
 *   firstRun  nobody has signed in here yet
 *   stuck     from another computer, neither GitHub sign-in nor a
 *             signed-in browser can let this one in
 *
 * Pure: the server passes in what it knows.
 */

/** The setting that turns Sign in with GitHub on. */
export const GITHUB_CLIENT_SETTING = "web.github_client_id";

export interface SigninMethods {
  github: "ready" | "no_client_id" | "no_owner";
  setting: typeof GITHUB_CLIENT_SETTING;
  browser: boolean;
  terminal: string;
  remote: boolean;
  firstRun: boolean;
  stuck: boolean;
}

export function signinMethods(o: {
  github: {
    state: "ready" | "claim" | "no_client_id" | "no_owner";
    ownerGithub?: string;
    org?: string;
  };
  signedInBrowser: boolean;
  remote: boolean;
  firstRun: boolean;
  terminal: string;
}): SigninMethods {
  const g = o.github;
  const github: SigninMethods["github"] =
    g.state === "ready" || (g.state === "claim" && !!g.ownerGithub)
      ? "ready"
      : g.state === "no_client_id"
        ? "no_client_id"
        : "no_owner";
  return {
    github,
    setting: GITHUB_CLIENT_SETTING,
    browser: o.signedInBrowser,
    terminal: o.terminal,
    remote: o.remote,
    firstRun: o.firstRun,
    stuck: o.remote && github !== "ready" && !o.signedInBrowser,
  };
}
