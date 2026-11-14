/**
 * D80: `<cli> web url [<address>]`: this install's address (web.url), the
 * one people are given. With no address it says what is set, and whether
 * a one-time migration wrote it (then giving it confirms it). A person's
 * only: an agent's session can read it, never set it.
 *
 * MODE-5 (0.4.46): the page's rules. A loopback name is refused, and the
 * running web server checks the address answers as this Den (its one-time
 * probe, web-url-routes.ts) and saves it only then. `--no-check` saves it
 * unchecked, for an install whose web server hasn't run yet (set the
 * address first, then start it).
 */
import { product } from "../../shared/product.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { cliAuthHeaders } from "../../shared/web-secret.js";
import { denWebBase } from "../../shared/web-dial.js";
import { checkWebUrl, loopbackRefusal } from "../../shared/web-url-check.js";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import {
  notSetLine,
  readWebUrl,
  setWebUrl,
  type WebUrl,
} from "../../shared/web-url.js";

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  read: () => WebUrl | null;
  set: (address: string) => string;
  /**
   * The running web server checks `url` answers as this Den and saves it
   * (POST /api/web-url). `down`: no web server answered.
   */
  checkAndSave: (
    url: string,
  ) => Promise<
    { ok: true; url: string } | { ok: false; error: string; down?: boolean }
  >;
}

/** POST /api/web-url on this install's own web server, as the person. */
async function serverCheckAndSave(
  url: string,
): Promise<
  { ok: true; url: string } | { ok: false; error: string; down?: boolean }
> {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  let r: Response;
  try {
    r = await fetch(`${denWebBase(port)}/api/web-url`, {
      method: "POST",
      headers: { "content-type": "application/json", ...cliAuthHeaders() },
      body: JSON.stringify({ url }),
      // The server's own check waits web.url_check_seconds; this, a bit more.
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { ok: false, error: "the web server is not running", down: true }; // words-ok: the CLI's own name for what `web up` starts
  }
  const b = (await r.json().catch(() => null)) as {
    ok?: boolean;
    url?: string;
    error?: string;
  } | null;
  if (r.ok && b?.ok && typeof b.url === "string")
    return { ok: true, url: b.url };
  return {
    ok: false,
    error: b?.error ?? `the web server answered ${r.status}`, // words-ok: the CLI's own name for what `web up` starts
  };
}

const stdIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  read: () => readWebUrl(),
  set: (a) => setWebUrl(a),
  checkAndSave: serverCheckAndSave,
};

export function webUrlUsage(cli = product().cli): string {
  return `Usage: ${cli} web url [<address>] [--no-check] [--json]\n  This install's address, for example https://${cli}.local.example.com: the one Den gives people (the start banner, web up, sign-in links, doctor, Hub). Set it once; the name must reach this machine from every device that uses it.\n  The running web server first checks the address answers as this install, and it is saved only then. A name for this machine only (localhost, 127.0.0.1, ::1) is refused.\n  --no-check  save it without the check: for an install whose web server hasn't run yet (set the address, then \`${cli} web up\`).\n  Same as Settings › the address.\n`; // words-ok: the CLI's own name for what `web up` starts
}

export async function cmdWebUrl(
  args: string[],
  io: Io = stdIo,
): Promise<number> {
  const cli = product().cli;
  if (args.includes("--help") || args.includes("-h")) {
    io.out(webUrlUsage(cli));
    return 0;
  }
  const json = args.includes("--json");
  const noCheck = args.includes("--no-check");
  const rest = args.filter((a) => a !== "--json" && a !== "--no-check");
  if (rest.length > 1 || rest.some((a) => a.startsWith("-"))) {
    io.err(webUrlUsage(cli));
    return 2;
  }
  if (rest.length === 0) {
    const w = io.read();
    if (json) {
      io.out(
        `${JSON.stringify(w ? { ok: true, ...w } : { ok: false, url: null, error: notSetLine(cli) })}\n`,
      );
      return w ? 0 : 1;
    }
    if (!w) {
      io.err(`${cli}: ${notSetLine(cli)}\n`);
      return 1;
    }
    io.out(`${w.url}\n`);
    if (!w.confirmed)
      io.err(
        `${cli}: taken from ${w.from ?? "what this install had"}; confirm it with \`${cli} web url ${w.url}\`\n`,
      );
    return 0;
  }
  if (isAgentTokenEnv(io.env)) {
    io.err(
      `${cli}: only a person sets this install's address (this is an agent)\n`,
    );
    return 1;
  }
  const fail = (error: string, code: number): number => {
    if (json) io.out(`${JSON.stringify({ ok: false, error, saved: false })}\n`);
    else io.err(`${cli}: ${error}\n`);
    return code;
  };
  const ok = checkWebUrl(rest[0]);
  if (!("url" in ok)) return fail(ok.error, 2);
  const loop = loopbackRefusal(ok.url);
  if (loop) return fail(loop, 2);
  let url: string;
  if (noCheck) {
    try {
      url = io.set(ok.url);
    } catch (e) {
      return fail((e as Error).message, 2);
    }
  } else {
    const r = await io.checkAndSave(ok.url);
    if (!r.ok)
      return fail(
        r.down
          ? `${r.error}, so ${ok.url} can't be checked. Start it (\`${cli} web up\`) and try again, or save it unchecked with --no-check (for an install whose web server hasn't run yet). Not saved.` // words-ok: the CLI's own name for what `web up` starts
          : r.error,
        1,
      );
    url = r.url;
  }
  if (json) io.out(`${JSON.stringify({ ok: true, url, confirmed: true })}\n`);
  else
    io.out(
      `✓ This install's address is ${url}. Restart the web server to use it everywhere: ${cli} web restart\n`,
    );
  return 0;
}
