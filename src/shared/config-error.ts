/**
 * A distribution config that fails validation (ORG-1d's `orgs:` checks, for
 * now). It is the user's to fix, not a crash: the CLI prints it and exits 1
 * before doing anything, and the web server answers it as
 * `{ ok: false, error, code: "config_invalid" }` with status 422.
 *
 * The message names config keys (`orgs.initech.repos`), never values a
 * secret could hide in.
 */
export class ConfigError extends Error {
  readonly code = "config_invalid";

  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
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
} {
  return { ok: false, error: e.message, code: e.code };
}
