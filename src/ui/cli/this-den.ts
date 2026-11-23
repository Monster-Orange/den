/**
 * den#182: an agent's Den token goes only to this Den. Whatever answers at
 * the base says whose it is first (/api/server-info); anything else gets
 * no request with the token. Shared by `hub put|pull|push` and, for issue
 * 785, `agents report-resume`.
 */
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { product } from "../../shared/product.js";
import { denWebBase } from "../../shared/web-dial.js";
import {
  foreignServerMessage,
  identifyServer,
  ownServer,
  type ServerIdentity,
} from "./server-identity.js";

/** Whose server answers at `base`. */
export function identifyBase(base: string): Promise<ServerIdentity> {
  const u = new URL(base);
  return identifyServer(
    Number(u.port) || 80,
    ownServer(),
    undefined,
    u.hostname.replace(/^\[|\]$/g, ""),
  );
}

/** Den's web server as an agent on this machine reaches it. */
export function defaultDenBase(): string {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  return denWebBase(port);
}

/**
 * True when this Den answers at `base`; otherwise says why on `err`,
 * prefixed with `what` (the command, e.g. "den hub push").
 */
export async function thisDen(
  what: string,
  base: string,
  identify: ((base: string) => Promise<ServerIdentity>) | undefined,
  err: (l: string) => void,
): Promise<boolean> {
  const cli = product().cli;
  const id = await (identify ?? identifyBase)(base);
  if (id.kind === "ours") return true;
  const port = new URL(base).port;
  err(
    id.kind === "none"
      ? `${what}: Den isn't answering at ${base}. Is it running (\`${cli} web up\`)?`
      : id.kind === "foreign"
        ? `${what}: ${foreignServerMessage(Number(port), id.who)}, not this Den; the agent's token was not sent.`
        : `${what}: what answers at ${base} did not say in time whose it is, so it is not known to be this Den; the agent's token was not sent. Try again.`,
  );
  return false;
}
