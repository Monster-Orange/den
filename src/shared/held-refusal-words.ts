/**
 * Issue 577: the refusals a held write's check writes itself, each under a
 * message key, so the person reads them in their language. A check returns
 * refusal(key, vars): the English `error` (for the agent, the audit and a
 * page with no key) and its sibling `errorKey: { key, vars }`, which the
 * page renders with t(key, vars). The en, es and ja catalogs carry each key
 * (shell.js, i18n/es.js, i18n/ja.js); tests/unit/server/
 * held-refusal-keys-577.test.ts checks that en is this text word for word.
 *
 * __DEN_TITLE__ is the product's title, as in the page catalogs.
 */
import type { DetailKey } from "./review-lines.js";

export const REFUSAL_WORDS: Record<string, string> = {
  "ap.err.giveService": "give service: <repo> or <repo>/<service>",
  "ap.err.projectName":
    'project "{project}" needs at least one letter or digit',
  "ap.err.noProject": 'there is no project "{project}"',
  "ap.err.giveReason": "give reason (one line: why)",
  "ap.err.reasonLong": "reason is at most {max} characters",
  "ap.err.cantRestart": "this __DEN_TITLE__ can't restart itself",
  "ap.err.versionForm": "version: latest, or one like 0.4.44",
  "ap.err.cantUpdate": "this __DEN_TITLE__ can't update itself",
  "ap.err.cantStartAgents": "this __DEN_TITLE__ can't start agents here",
  "ap.err.cantPersonas": "this __DEN_TITLE__ can't change personas here",
  "ap.err.cantHubLink": "this __DEN_TITLE__ can't link projects to Hub here",
  "ap.err.cantClone": "this __DEN_TITLE__ can't clone repos here",
  "ap.err.reposShared":
    "the repos folder is shared by every project: __DEN_TITLE__'s own agent or a person asks to clone into it, not {agent}",
  "ap.err.reposSharedAgent":
    "the repos folder is shared by every project: __DEN_TITLE__'s own agent or a person asks to clone into it, not a project's agent",
  "ap.err.cantImport": "this __DEN_TITLE__ can't bring in conversations here",
  "ap.err.nameProject": "name the project",
  "ap.err.importOwn":
    "a project's agent brings conversations into its own project ({own}), not {project}",
  "ap.err.sessionId": "`session` must be a conversation id",
  "ap.err.namePersona": "name the persona to run it as",
  "ap.err.runtimeId": "runtime must be a runtime id",
  "ap.err.cantPolicy":
    "this __DEN_TITLE__ can't change the approval policy here",
  "ap.err.policyOwn":
    "a project's agent asks about its own project ({own}), not {project}",
  "ap.err.policyInstall":
    "the install's policy is every project's: __DEN_TITLE__'s own agent or a person asks to change it; name your project to change its own",
  "ap.err.policyForm":
    "approvals: { policy, writes, watch, critical }, or null to clear it",
  "ap.err.cantClosePr": "this __DEN_TITLE__ can't close pull requests here",
  "ap.err.closePrOwn":
    "a project's agent closes pull requests for its own project ({own}), not {project}",
  "ap.err.repoForm": "repo: a GitHub repo, owner/name",
  "ap.err.prNumber": "pr: the pull request number",
  "ap.err.commentForm":
    "comment: why it closes, posted on the pull request (the Hub note: stale, or superseded by which)",
  "ap.err.cantReport": "this __DEN_TITLE__ can't file reports here",
  // The pin commit (pin-commit.ts): Den's words; git's output is a var.
  "ap.err.pinNotCheckout": "{root} is not a git checkout",
  "ap.err.pinDetached":
    "the distribution's checkout is on no branch (detached HEAD)",
  "ap.err.pinPush":
    "the pin is committed, but git push to {remote} {branch} failed: {out}",
  "ap.err.pinCommit": "couldn't commit the pin: {why}",
  "ap.err.pinBranch":
    "the pin branch {branch} is pushed, but its pull request couldn't be opened: {why}",
};

export type RefusalKey = keyof typeof REFUSAL_WORDS & string;

/** A check's refusal: its English (with `title`) and its key. */
export function refusal(
  key: RefusalKey,
  vars: Record<string, string> = {},
  title = "Den",
): { ok: false; error: string; errorKey: DetailKey } {
  const en = REFUSAL_WORDS[key] ?? key;
  const error = en
    .replace(/__DEN_TITLE__/g, title)
    .replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return {
    ok: false,
    error,
    errorKey: Object.keys(vars).length ? { key, vars } : { key },
  };
}
