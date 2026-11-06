/**
 * Which environment variables are credentials, by name or by value. One
 * set of patterns for everything that checks an environment: the test
 * workers (tests/scrub-env.ts), the audit of `sessions start --keep-env`,
 * and `<cli> doctor --probe` (with the text redactor's own patterns,
 * redact.ts). They err on the side of flagging: a harmless variable called
 * a credential costs less than a token called harmless.
 *
 * Nothing here returns or logs a value.
 */

import { redactSecrets, SECRET_PATTERNS } from "./redact.js";

/** Variable names that hold credentials. */
const SECRET_NAME =
  /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_KEY|ACCESS_KEY|AUTH)/i;

/** Whole families of credential variables. */
const SECRET_PREFIX = /^(OP_|DOPPLER_|AWS_|GH_|GITHUB_|NPM_|ANTHROPIC_)/i;

/** Values shaped like well-known tokens, whatever the variable is called. */
const SECRET_VALUE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|ops_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|dp\.(st|ct|sa|scim)\.[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/;

/** Whether a variable looks like a credential, by name or by value. */
export function isCredentialEnv(
  name: string,
  value: string | undefined,
): boolean {
  return (
    SECRET_NAME.test(name) ||
    SECRET_PREFIX.test(name) ||
    (value !== undefined && SECRET_VALUE.test(value))
  );
}

/**
 * Credential-shaped: by name or value (isCredentialEnv), or a value the
 * text redactor would redact.
 */
export function isCredentialShaped(
  name: string,
  value: string | undefined,
): boolean {
  return (
    isCredentialEnv(name, value) ||
    (value !== undefined && value !== "" && redactSecrets(value) !== value)
  );
}

/**
 * Every pattern isCredentialShaped uses, as plain data (source and flags,
 * global flag dropped), for a check run in another process (the probe).
 */
export function credentialPatternData(): {
  name: { source: string; flags: string }[];
  value: { source: string; flags: string }[];
} {
  const data = (re: RegExp) => ({
    source: re.source,
    flags: re.flags.replace("g", ""),
  });
  return {
    name: [SECRET_NAME, SECRET_PREFIX].map(data),
    value: [SECRET_VALUE, ...SECRET_PATTERNS.map((p) => p.re)].map(data),
  };
}

/** An environment variable name (`--keep-env NAME`). */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
