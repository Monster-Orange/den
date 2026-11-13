/**
 * `<cli> hub push <dir> [--request "<why>"]` (D52): an agent sends an
 * import pack to Hub, through Den. It runs inside an agent Den started and
 * calls Den's proxy to Hub (`http://localhost:<port>/hub`) with that
 * agent's own Den token (DEN_ACTOR_TOKEN); Den attaches the install's Hub
 * token and who is calling. This command never reads, holds or prints a
 * Hub token.
 *
 * A pack is a folder: pack.json, and blobs/<sha256> for each file. Four
 * calls, as Hub's import API asks (its sizes are Hub's own; its errors are
 * shown as Hub words them):
 *   1. POST /api/import/packs (pack.json) → { pack, files, missing }
 *   2. PUT  /api/import/packs/<pack>/files/<sha> for each missing file,
 *      four at a time
 *   3. POST /api/import/packs/<pack>/dry-run → what would change
 *   4. with --request: POST /api/import/packs/<pack>/request { reason }
 *      → a held action a person approves in Hub (its link is printed)
 * Nothing here applies anything.
 */
import * as fs from "fs";
import * as path from "path";
import { actorTokenOf } from "../../shared/actor-token.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { product } from "../../shared/product.js";

export const HUB_HELP = {
  usage: "hub <push|link> …",
  lines: [
    "{cli} hub link -p <project> [<hub project> | --none] [--json]",
    "    The Hub project this project works on: Hub files its agents' work",
    "    there. With no Hub project named, shows the link and Hub's",
    "    suggestions (the same repo, then the same name). --none unlinks.",
    "    A person's ask only. Also in Settings › Project setup.",
    "",
    "{cli} hub link --suggested [--json]",
    "    Every unlinked project with Hub's suggestion, and the Settings page",
    "    that links the ticked ones in one go. Links nothing itself.",
    "",
    "Send an import pack to Hub, from an agent Den started: through Den, with",
    "that agent's own Den token (Den adds Hub's). Never a Hub token here.",
    "",
    '{cli} hub push <dir> [--request "<why>"] [--json]',
    "    <dir> holds pack.json and blobs/<sha256>. Stages the pack, uploads",
    "    the files Hub lacks, and prints Hub's dry run. With --request, asks",
    "    a person to apply it, and prints the link where they approve it.",
  ],
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface HubCommandDeps {
  env?: Record<string, string | undefined>;
  /** Den's web server as this agent reaches it (http://localhost:<port>). */
  denBase?: () => string;
  fetch?: Fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Uploads at once. */
  parallel?: number;
}

function defaultDenBase(): string {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  return `http://localhost:${port}`;
}

/** A one-line, bounded, printable error from Hub (or Den). */
const oneLine = (s: string) =>
  s
    .replace(/[^\x20-\x7e]+/g, " ")
    .trim()
    .slice(0, 400);

class HubCallError extends Error {}

export async function cmdHub(
  args: readonly string[],
  deps: HubCommandDeps = {},
): Promise<number> {
  const cli = product().cli;
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = deps.env ?? process.env;
  const usage = () => {
    err(`usage: ${cli} ${HUB_HELP.usage}`);
    return 2;
  };
  if (args[0] === "link") {
    const { cmdHubLink } = await import("./hub-link-command.js");
    return cmdHubLink(args.slice(1), { env, out, err });
  }
  if (args[0] !== "push") return usage();
  let dir: string | undefined;
  let reason: string | undefined;
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--request") {
      reason = args[++i];
      if (!reason?.trim()) {
        err(`${cli} hub push: --request needs the reason a person will read`);
        return 2;
      }
    } else if (a.startsWith("--request=")) reason = a.slice(10);
    else if (a.startsWith("-") || dir !== undefined) return usage();
    else dir = a;
  }
  if (!dir) return usage();

  const token = actorTokenOf(env);
  if (!token) {
    err(
      `${cli} hub push runs inside an agent Den started: it calls Hub as that agent, with its own Den token. ` +
        "Ask the agent to run it, or start one.",
    );
    return 2;
  }
  const packFile = path.join(dir, "pack.json");
  let raw: Buffer;
  try {
    raw = fs.readFileSync(packFile);
  } catch {
    err(`${cli} hub push: no pack.json in ${dir}`);
    return 1;
  }

  const base = `${(deps.denBase ?? defaultDenBase)().replace(/\/+$/, "")}/hub`;
  const f: Fetch = deps.fetch ?? ((u, i) => fetch(u, i));
  const call = async (
    method: string,
    p: string,
    body?: RequestInit["body"],
    type?: string,
  ): Promise<Record<string, unknown>> => {
    let res: Response;
    try {
      res = await f(`${base}${p}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(type ? { "content-type": type } : {}),
        },
        body,
        redirect: "manual",
      });
    } catch {
      throw new HubCallError(
        `Den's web server didn't answer at ${base}. Is it running (\`${cli} web up\`)?`,
      );
    }
    const text = await res.text();
    let body2: Record<string, unknown> = {};
    try {
      body2 = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON: its text is the error */
    }
    if (!res.ok) {
      const said =
        typeof body2.error === "string" ? body2.error : text.slice(0, 300);
      throw new HubCallError(`${method} ${p}: ${res.status} ${oneLine(said)}`);
    }
    return body2;
  };

  try {
    const staged = (await call(
      "POST",
      "/api/import/packs",
      new Uint8Array(raw),
      "application/json",
    )) as { pack?: unknown; files?: unknown; missing?: unknown };
    const pack = String(staged.pack ?? "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(pack))
      throw new HubCallError("Hub's answer to the pack has no pack id");
    const missing = Array.isArray(staged.missing)
      ? staged.missing.map(String)
      : [];
    if (!json)
      out(
        `staged ${pack}: ${Number(staged.files) || 0} files, ${missing.length} to upload`,
      );
    const queue = [...missing];
    let uploaded = 0;
    const worker = async () => {
      for (let sha = queue.shift(); sha; sha = queue.shift()) {
        if (!/^[0-9a-f]{64}$/.test(sha))
          throw new HubCallError("Hub asked for a file that isn't a sha256");
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(path.join(dir!, "blobs", sha));
        } catch {
          throw new HubCallError(
            `the pack names blobs/${sha}, and it isn't in ${dir}`,
          );
        }
        await call(
          "PUT",
          `/api/import/packs/${pack}/files/${sha}`,
          new Uint8Array(bytes),
          "application/octet-stream",
        );
        uploaded++;
        if (!json && uploaded % 100 === 0)
          out(`uploaded ${uploaded}/${missing.length}`);
      }
    };
    await Promise.all(
      Array.from({ length: Math.max(1, deps.parallel ?? 4) }, worker),
    );
    if (!json && uploaded) out(`uploaded ${uploaded} files`);
    const dryRun = await call("POST", `/api/import/packs/${pack}/dry-run`);
    let held: Record<string, unknown> | undefined;
    if (reason !== undefined)
      held = await call(
        "POST",
        `/api/import/packs/${pack}/request`,
        JSON.stringify({ reason }),
        "application/json",
      );
    if (json) {
      out(
        JSON.stringify(
          { pack, uploaded, dryRun, ...(held ? { held } : {}) },
          null,
          2,
        ),
      );
      return 0;
    }
    out("dry run:");
    out(JSON.stringify(dryRun, null, 2));
    if (held) {
      if (typeof held.summary === "string")
        out(`asked: ${oneLine(held.summary)}`);
      if (typeof held.url === "string")
        out(`a person approves it at ${oneLine(held.url)}`);
    } else
      out(
        `to ask a person to apply it: ${cli} hub push ${dir} --request "<why>"`,
      );
    return 0;
  } catch (e) {
    err(
      `${cli} hub push: ${e instanceof HubCallError ? e.message : oneLine(String((e as Error)?.message ?? e))}`,
    );
    return 1;
  }
}
