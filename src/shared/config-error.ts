/**
 * A distribution config that fails validation (ORG-1d's `orgs:` checks, for
 * now). It is the user's to fix, not a crash: the CLI prints it and exits 1
 * before doing anything, and the web server answers it as
 * `{ ok: false, error, code: "config_invalid" }` with status 422.
 *
 * The message names config keys (`orgs.initech.repos`), never values a
 * secret could hide in.
 */
/**
 * One validation problem: the config file (as the distribution names it),
 * the key path (`orgs.acme.sources[0].owner`) and what is wrong with it.
 * `text` is the whole line after "<file>: ".
 */
export interface ConfigIssue {
  file: string;
  key: string;
  message: string;
  text: string;
}

export class ConfigError extends Error {
  readonly code = "config_invalid";
  /** Every problem found (0.3.0-dev.40), in config order. */
  readonly issues: ConfigIssue[];

  /**
   * The message is one line per issue, "<file>: <text>". A plain string is
   * one issue-less message.
   */
  constructor(issues: ConfigIssue[] | string) {
    const list = typeof issues === "string" ? [] : issues;
    super(
      typeof issues === "string"
        ? issues
        : list.map((i) => `${i.file}: ${i.text}`).join("\n"),
    );
    this.name = "ConfigError";
    this.issues = list;
  }
}

export function isConfigError(e: unknown): e is ConfigError {
  return e instanceof ConfigError;
}

/** The web server's status for a ConfigError: the request was fine, the config is not. */
export const CONFIG_ERROR_STATUS = 422;

/** The JSON body for a ConfigError (the `{ok, error, code}` frame R26 extends). */
export function configErrorBody(e: ConfigError): {
  ok: false;
  error: string;
  code: "config_invalid";
  issues: Array<{ file: string; key: string; message: string }>;
} {
  return {
    ok: false,
    error: e.message,
    code: e.code,
    issues: e.issues.map(({ file, key, message }) => ({ file, key, message })),
  };
}
