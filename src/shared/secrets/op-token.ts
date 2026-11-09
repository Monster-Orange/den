/**
 * Where the 1Password service-account token comes from, and why `op` failed.
 *
 * A Den running as a service (launchd, systemd) does not read a login shell,
 * so `op` has no OP_SERVICE_ACCOUNT_TOKEN of its own. `secrets.onepassword.token`
 * in config/local/user.yml (per machine, never the distribution's) says
 * where to read one:
 *
 *   keychain:<service>   macOS: `security find-generic-password -s <service> -w`
 *   file:<path>          a file whose mode is exactly 600; `~` expands
 *   env:<VAR>            an env var of this process (the default is
 *                        env:OP_SERVICE_ACCOUNT_TOKEN)
 *
 * The token is read when a ref is resolved, never cached, and goes only into
 * the `op` child's env. Nothing here returns it in text: every message names
 * the source, never the token.
 */
import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const OP_TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";
const SECURITY_TIMEOUT_MS = 10_000;

export type OpTokenSource =
  | { kind: "keychain"; service: string }
  | { kind: "file"; path: string }
  | { kind: "env"; name: string };

export const DEFAULT_OP_TOKEN_SOURCE: OpTokenSource = {
  kind: "env",
  name: OP_TOKEN_ENV,
};

const SHAPE =
  "must be keychain:<service>, file:<path> or env:<VAR> (for example env:OP_SERVICE_ACCOUNT_TOKEN)";

/** Why `raw` is not a valid token source, or null. Never echoes `raw`. */
export function opTokenSourceError(raw: unknown): string | null {
  if (typeof raw !== "string") return SHAPE;
  const m = /^(keychain|file|env):(.*)$/s.exec(raw);
  if (!m) return SHAPE;
  const [, kind, rest] = m;
  // eslint-disable-next-line no-control-regex
  if (rest.trim() === "" || /[\u0000-\u001f]/.test(rest))
    return `${kind}: needs a value on one line; ${SHAPE}`;
  if (kind === "env" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest))
    return `env: needs an env var name; ${SHAPE}`;
  if (kind === "keychain" && rest.startsWith("-"))
    return `keychain: service name must not start with "-"; ${SHAPE}`;
  return null;
}

/** The source `raw` names (unset: the default). Throws, naming `where`. */
export function parseOpTokenSource(
  raw: unknown,
  where = "secrets.onepassword.token",
): OpTokenSource {
  if (raw === undefined || raw === null) return DEFAULT_OP_TOKEN_SOURCE;
  const err = opTokenSourceError(raw);
  if (err) throw new Error(`${where} ${err}`);
  const s = raw as string;
  const i = s.indexOf(":");
  const kind = s.slice(0, i);
  const rest = s.slice(i + 1);
  if (kind === "keychain") return { kind, service: rest };
  if (kind === "file") return { kind, path: rest };
  return { kind: "env", name: rest };
}

/** "keychain: <service>", "file: <path>" or "env: <VAR>": what people see. */
export function describeOpTokenSource(src: OpTokenSource): string {
  if (src.kind === "keychain") return `keychain: ${src.service}`;
  if (src.kind === "file") return `file: ${src.path}`;
  return `env: ${src.name}`;
}

export type OpTokenResult =
  | { ok: true; token: string }
  | { ok: false; reason: string };

export interface OpTokenDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return path.join(home, p.slice(2));
  return p;
}

function fail(src: OpTokenSource, why: string): OpTokenResult {
  return {
    ok: false,
    reason: `token source ${describeOpTokenSource(src)}: ${why}`,
  };
}

function readTokenFile(src: { kind: "file"; path: string }, home: string) {
  const file = expandHome(src.path, home);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return fail(src, "file not found or not readable");
  }
  if (!st.isFile()) return fail(src, "not a regular file");
  const mode = st.mode & 0o777;
  if (mode !== 0o600)
    return fail(
      src,
      `file mode is ${mode.toString(8).padStart(3, "0")}; it must be 600 (chmod 600 the file)`,
    );
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return fail(src, "file not readable");
  }
  const token = text.replace(/[\r\n]+$/, "");
  return token ? ({ ok: true, token } as const) : fail(src, "file is empty");
}

function fromEnv(src: { kind: "env"; name: string }, env: NodeJS.ProcessEnv) {
  const v = env[src.name];
  return v
    ? ({ ok: true, token: v } as const)
    : fail(src, "env var is not set");
}

const NOT_MAC = "the macOS keychain is not available on this system";

/**
 * Read the token now. Never cached. The failure reason names the source,
 * never the token.
 */
export async function readOpToken(
  src: OpTokenSource,
  deps: OpTokenDeps = {},
): Promise<OpTokenResult> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  if (src.kind === "env") return fromEnv(src, env);
  if (src.kind === "file") return readTokenFile(src, home);
  if ((deps.platform ?? process.platform) !== "darwin")
    return fail(src, NOT_MAC);
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", src.service, "-w"],
      { timeout: SECURITY_TIMEOUT_MS, env },
    );
    const token = String(stdout).replace(/[\r\n]+$/, "");
    return token ? { ok: true, token } : fail(src, "keychain item is empty");
  } catch {
    return fail(src, "keychain item not found or not readable");
  }
}

/**
 * Whether the source yields a token, for `doctor`: the same checks, but a
 * keychain item is only looked up (no `-w`), so nothing is read and no
 * keychain prompt can appear. Returns the reason, or null when it works.
 */
export function opTokenSourceProblem(
  src: OpTokenSource,
  deps: OpTokenDeps = {},
): string | null {
  const env = deps.env ?? process.env;
  const home = deps.home ?? os.homedir();
  if (src.kind === "env") {
    const r = fromEnv(src, env);
    return r.ok ? null : r.reason;
  }
  if (src.kind === "file") {
    const r = readTokenFile(src, home);
    return r.ok ? null : r.reason;
  }
  if ((deps.platform ?? process.platform) !== "darwin")
    return `token source ${describeOpTokenSource(src)}: ${NOT_MAC}`;
  try {
    execFileSync("security", ["find-generic-password", "-s", src.service], {
      timeout: SECURITY_TIMEOUT_MS,
      env,
      stdio: "ignore",
    });
    return null;
  } catch {
    return `token source ${describeOpTokenSource(src)}: keychain item not found`;
  }
}

export type OpFailureCode =
  | "no_token"
  | "no_access"
  | "not_found"
  | "rate_limited"
  | "token_source"
  | "unknown";

export interface OpFailureInfo {
  code: OpFailureCode;
  /** Plain words, safe to show. */
  text: string;
}

/**
 * Map `op`'s stderr to one plain reason. Pure. `redact` lists strings (the
 * token) to blank out of the unknown case's summary.
 */
export function mapOpFailure(
  stderr: string,
  redact: readonly string[] = [],
): OpFailureInfo {
  const s = stderr ?? "";
  if (
    /not signed in|no active session|service account token|sign ?in|session (has )?expired|authenticat|no accounts? (configured|found)/i.test(
      s,
    )
  )
    return {
      code: "no_token",
      text: "1Password has no service-account token or session for this process",
    };
  if (/rate.?limit|too many requests|\b429\b/i.test(s))
    return { code: "rate_limited", text: "1Password rate limited the request" };
  if (
    /isn't a vault|is not a vault|don't have access|do not have access|doesn't have access|not authorized|forbidden|permission|\b403\b|access denied/i.test(
      s,
    )
  )
    return { code: "no_access", text: "no access to the vault" };
  if (
    /isn't an item|isn't a field|is not an item|not found|no such|could not find|couldn't find|doesn't exist|does not exist|no (item|field)|more than one item/i.test(
      s,
    )
  )
    return { code: "not_found", text: "item or field not found" };
  let line =
    s
      .split(/\r?\n/)
      .map((l) =>
        l.replace(/^\[\w+\]\s*\d{4}\/\d\d\/\d\d \d\d:\d\d:\d\d\s*/, "").trim(),
      )
      .find((l) => l) ?? "";
  for (const r of redact) if (r) line = line.split(r).join("[hidden]");
  line = line.replace(/op:\/\/\S+/g, "[ref]");
  if (line.length > 100) line = `${line.slice(0, 100)}...`;
  return {
    code: "unknown",
    text: line ? `1Password failed: ${line}` : "1Password failed (no detail)",
  };
}

/** A failed 1Password read, with a reason that is safe to show. */
export class OpFailure extends Error {
  constructor(
    readonly code: OpFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "OpFailure";
  }
}
