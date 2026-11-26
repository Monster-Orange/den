/**
 * Issue 989 (sandbox, slice 3): person-only CLI verbs go through the
 * running server, with the person token (cliAuthHeaders), so the server's
 * person check is their boundary. The server makes the change and audits
 * it; the CLI writes nothing.
 *
 * Only when no server answers at all (nothing listens on its port) does a
 * verb write Den's state itself, as before, so a person's CLI still works
 * with Den stopped. Inside the agent sandbox (issue 936) an agent's direct
 * write is refused. A server that answers, even with a refusal or an
 * error, is never worked around: its answer is the verb's.
 */
import * as net from "net";
import * as os from "os";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { webProbeTarget } from "../../shared/web/web-dial.js";
import { cliAuthHeaders } from "../../shared/web/web-secret.js";

export interface ServerAnswer {
  status: number;
  json: Record<string, unknown> | null;
}

/** One call to this install's server: its answer, or null when none answered. */
export type PersonServer = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<ServerAnswer | null>;

/** Nothing listens there: the only case a verb writes the state itself. */
const NOT_LISTENING = new Set(["ECONNREFUSED", "EADDRNOTAVAIL"]);

/** How long a verb waits for the server's answer. */
const ANSWER_MS = 60_000;

/** What personServerFor reads (tests give their own). */
export interface PersonServerOptions {
  env?: Record<string, string | undefined>;
  /** The server's port (default: web.port, else Den's default). */
  port?: () => number;
  /** This machine's interface addresses (default: os.networkInterfaces). */
  localAddresses?: () => string[];
  /** The HTTP call (default: global fetch). */
  fetch?: typeof fetch;
}

function interfaceAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .map((a) => a?.address ?? "")
    .filter(Boolean);
}

/**
 * Whether `host` is this machine: a loopback IP, or an IP on one of its
 * interfaces. Never a hostname (a name can point anywhere).
 */
function isThisMachine(host: string, local: () => string[]): boolean {
  if (!net.isIP(host)) return false;
  if (host === "::1" || (net.isIPv4(host) && host.startsWith("127.")))
    return true;
  const h = host.toLowerCase();
  return local().some((a) => a.toLowerCase() === h);
}

/**
 * The real server of the install whose state is `stateDir`, at its bound
 * address. The call carries the person's bearer (and, for a sign-in
 * token, the token) over plain HTTP, so the address must be this machine
 * (isThisMachine): otherwise nothing is sent and the verb is refused.
 *
 * Under a test run (jest, or the test sentinel) it answers none, so a test
 * never changes this machine's Den: a test that means to reach a server it
 * started sets DEN_PERSON_SERVER=on. These come from the environment, so
 * outside the agent sandbox an agent could set one and take the local
 * write; that gains it nothing it couldn't do by writing the files, and
 * inside the sandbox (issue 936) the local write is refused.
 */
export function personServerFor(
  stateDir?: string,
  opts: PersonServerOptions = {},
): PersonServer {
  const env = opts.env ?? process.env;
  if (
    (env.JEST_WORKER_ID || env.DEN_TEST_SENTINEL) &&
    env.DEN_PERSON_SERVER !== "on"
  )
    return async () => null;
  return async (method, p, body) => {
    let port: number;
    try {
      port = opts.port ? opts.port() : readWebPort();
    } catch {
      port = DEFAULT_PORT;
    }
    const target = webProbeTarget(env.DEN_BIND_HOST, port);
    if (!isThisMachine(target.host, opts.localAddresses ?? interfaceAddresses))
      // Thrown before anything is sent: the verb writes nothing either.
      throw new Error(
        `DEN_BIND_HOST (${target.host}) is not this machine's address, so the person token isn't sent there; unset it or set it to an address this machine has. Nothing was changed`,
      );
    let r: Response;
    try {
      r = await (opts.fetch ?? fetch)(`http://${target.hostHeader}${p}`, {
        method,
        headers: {
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...cliAuthHeaders(stateDir),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(ANSWER_MS),
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code && NOT_LISTENING.has(code)) return null;
      // It may have made the change: never write it here as well.
      throw new Error(
        `${p}: the web app didn't answer (${code ?? (e as Error).name}); nothing was changed here`,
      );
    }
    const json = (await r.json().catch(() => null)) as unknown;
    return {
      status: r.status,
      json:
        json && typeof json === "object" && !Array.isArray(json)
          ? (json as Record<string, unknown>)
          : null,
    };
  };
}

/**
 * The server's answer when it made the change; null when no server
 * answered (the caller writes as before). A refusal or an error throws its
 * message: the caller writes nothing.
 */
export async function throughServer(
  server: PersonServer,
  method: "GET" | "POST" | "PUT" | "DELETE",
  p: string,
  body?: unknown,
): Promise<Record<string, unknown> | null> {
  const r = await server(method, p, body);
  if (r === null) return null;
  if (r.status >= 200 && r.status < 300 && r.json?.ok !== false)
    return r.json ?? {};
  throw new Error(
    typeof r.json?.error === "string" && r.json.error
      ? r.json.error
      : `the web app answered ${r.status}`,
  );
}
