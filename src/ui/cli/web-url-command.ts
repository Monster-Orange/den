/**
 * D80: `<cli> web url [<address>]`: this install's address (web.url), the
 * one people are given. With no address it says what is set, and whether
 * a one-time migration wrote it (then giving it confirms it). A person's
 * only: an agent's session can read it, never set it.
 */
import { product } from "../../shared/product.js";
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
}

const stdIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  read: () => readWebUrl(),
  set: (a) => setWebUrl(a),
};

export function webUrlUsage(cli = product().cli): string {
  return `Usage: ${cli} web url [<address>] [--json]\n  This install's address, for example https://${cli}.local.example.com: the one Den gives people (the start banner, web up, sign-in links, doctor, Hub). Set it once; the name must reach this machine from every device that uses it.\n`;
}

export function cmdWebUrl(args: string[], io: Io = stdIo): number {
  const cli = product().cli;
  if (args.includes("--help") || args.includes("-h")) {
    io.out(webUrlUsage(cli));
    return 0;
  }
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
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
      `${cli}: only a person sets this install's address (this is an agent's session)\n`,
    );
    return 1;
  }
  let url: string;
  try {
    url = io.set(rest[0]);
  } catch (e) {
    io.err(`${cli}: ${(e as Error).message}\n`);
    return 2;
  }
  if (json) io.out(`${JSON.stringify({ ok: true, url, confirmed: true })}\n`);
  else
    io.out(
      `✓ This install's address is ${url}. Restart the web server to use it everywhere: ${cli} web restart\n`,
    );
  return 0;
}
