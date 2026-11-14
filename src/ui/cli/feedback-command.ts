/**
 * FB (den#81): `<cli> feedback`, Report an issue from a shell. It uses the
 * page's own routes on this install's web server, as the person: the
 * server's preview (/api/report/preview) is printed, exactly what will be
 * posted, then y/N, then /api/report/send. Off a terminal it is refused
 * unless --yes. An agent is always refused: its reports stay drafts for a
 * person (the MCP feedback tools).
 */
import { product } from "../../shared/product.js";
import { DEFAULT_PORT } from "../../shared/constants.js";
import { readWebPort } from "../../shared/edge/config.js";
import { cliAuthHeaders } from "../../shared/web-secret.js";
import { denWebBase } from "../../shared/web-dial.js";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import * as readline from "readline";
import * as fs from "fs";

export interface FeedbackIo {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  /** Both ends are a terminal: a person can read the preview and answer. */
  tty: boolean;
  ask: (question: string) => Promise<string>;
  api: (
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; data: Record<string, unknown> }>;
}

export const FEEDBACK_HELP = {
  usage: "feedback [--title <t>] [--kind bug|idea|question] [options]",
  lines: [
    "Report an issue from a shell, the same as Report on any page. Prints",
    "exactly what will be posted, then asks before sending it to GitHub.",
    "  --description <text> | --description-file <path|->",
    "  --repo <owner/repo>   where it goes (default: the first destination)",
    "  --no-redact           keep host names and paths (on by default)",
    "  --add-to <n> | --new  when an open report has the same title",
    "  --preview             print it, send nothing",
    "  --yes                 send without asking (needed off a terminal)",
  ],
};

const KINDS = ["bug", "idea", "question"] as const;

async function httpApi(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let port: number;
  try {
    port = readWebPort();
  } catch {
    port = DEFAULT_PORT;
  }
  const r = await fetch(`${denWebBase(port)}${path}`, {
    method,
    headers: { "content-type": "application/json", ...cliAuthHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: r.status, data };
}

function stdAsk(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((ok) =>
    rl.question(question, (a) => {
      rl.close();
      ok(a);
    }),
  );
}

const stdIo: FeedbackIo = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  tty: !!process.stdin.isTTY && !!process.stdout.isTTY,
  ask: stdAsk,
  api: httpApi,
};

function usage(cli: string): string {
  return `Usage: ${cli} ${FEEDBACK_HELP.usage}\n${FEEDBACK_HELP.lines.map((l) => `  ${l}`).join("\n")}\n`;
}

export async function cmdFeedback(
  args: string[],
  io: FeedbackIo = stdIo,
): Promise<number> {
  const cli = product().cli;
  if (args.includes("--help") || args.includes("-h")) {
    io.out(usage(cli));
    return 0;
  }
  const opt: Record<string, string> = {};
  const flags = new Set<string>();
  const VALUED = [
    "--title",
    "--kind",
    "--description",
    "--description-file",
    "--repo",
    "--add-to",
  ];
  const FLAGS = ["--no-redact", "--new", "--preview", "--yes"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (VALUED.includes(a) && i + 1 < args.length) opt[a] = args[++i]!;
    else if (FLAGS.includes(a)) flags.add(a);
    else {
      io.err(`${cli}: unknown option ${a}\n${usage(cli)}`);
      return 2;
    }
  }
  const fail = (msg: string, code = 1): number => {
    io.err(`${cli}: ${msg}\n`);
    return code;
  };
  if (isAgentTokenEnv(io.env))
    return fail(
      "only a person sends a report. An agent saves it as a draft for a person to send (the feedback tools over MCP).",
    );
  const yes = flags.has("--yes");
  const preview = flags.has("--preview");
  if (!io.tty && !yes && !preview)
    return fail(
      "sending a report needs a person at a terminal to read it first. Run it in one, or read it with --preview and send it with --yes.",
      2,
    );

  let kind = opt["--kind"];
  let title = opt["--title"];
  let description = opt["--description"];
  if (kind !== undefined && !KINDS.includes(kind as (typeof KINDS)[number]))
    return fail("--kind is bug, idea or question", 2);
  if (opt["--description-file"] !== undefined) {
    try {
      const f = opt["--description-file"];
      description = fs.readFileSync(f === "-" ? 0 : f, "utf-8");
    } catch (e) {
      return fail(`can't read the description: ${(e as Error).message}`, 2);
    }
  }
  const addTo =
    opt["--add-to"] !== undefined ? Number(opt["--add-to"]) : undefined;
  if (addTo !== undefined && !(Number.isInteger(addTo) && addTo > 0))
    return fail("--add-to is an issue number", 2);
  if (!title && !io.tty) return fail("--title is needed off a terminal", 2);
  if (io.tty && !title) {
    if (kind === undefined) {
      const k = (await io.ask("Kind (bug, idea, question) [bug]: "))
        .trim()
        .toLowerCase();
      kind = k || "bug";
      if (!KINDS.includes(kind as (typeof KINDS)[number]))
        return fail("the kind is bug, idea or question", 2);
    }
    title = (await io.ask("Title: ")).trim();
    if (!title) return fail("a title is needed. Not sent.", 2);
    if (description === undefined)
      description = await io.ask("Description (optional): ");
  }
  kind = kind ?? "bug";

  let info: { status: number; data: Record<string, unknown> };
  try {
    info = await io.api("GET", "/api/report");
  } catch {
    return fail(
      `the web app is not running, so the report can't be made. Start it (\`${cli} web up\`) and try again.`,
    );
  }
  if (info.status !== 200)
    return fail(
      String(info.data.error ?? `the web app answered ${info.status}`),
    );
  const repos = Array.isArray(info.data.repos)
    ? (info.data.repos as { repo?: unknown }[])
        .map((r) => r.repo)
        .filter((r): r is string => typeof r === "string")
    : [];
  const repo = opt["--repo"] ?? repos[0];
  if (!repo || !repos.includes(repo))
    return fail(
      `--repo is one of this install's destinations: ${repos.join(", ") || "none"}`,
      2,
    );
  const form = {
    kind,
    title,
    description: description ?? "",
    repo,
    redact: !flags.has("--no-redact"),
    sections: {},
    client: {},
  };
  const p = await io.api("POST", "/api/report/preview", form);
  if (p.status !== 200)
    return fail(String(p.data.error ?? `the preview failed (${p.status})`));
  io.out(
    `To: ${repo} (anyone who can see this repo can read it)\nTitle: ${String(p.data.title)}\n\n${String(p.data.body)}\n\n`,
  );
  if (preview) return 0;
  if (!yes) {
    const a = (await io.ask(`Send this to ${repo} on GitHub? [y/N] `))
      .trim()
      .toLowerCase();
    if (a !== "y" && a !== "yes") {
      io.out("Not sent.\n");
      return 1;
    }
  }

  let extra: Record<string, unknown> =
    addTo !== undefined
      ? { addTo }
      : flags.has("--new")
        ? { fileNew: true }
        : {};
  for (;;) {
    const r = await io.api("POST", "/api/report/send", { ...form, ...extra });
    if (r.status === 200) {
      const url = String(r.data.url ?? "");
      io.out(
        r.data.added
          ? `✓ Added to #${String(extra.addTo)}: ${url}\n`
          : `✓ Filed: ${url}\n`,
      );
      return 0;
    }
    const dup = r.data.duplicate as
      | { number: number; title: string; url: string }
      | undefined;
    if (r.status === 409 && dup) {
      if (!io.tty || yes)
        return fail(
          `an open report has this title: #${dup.number} ${dup.url}. Run it again with --add-to ${dup.number} to add to it, or --new to file a new one. Not sent.`,
        );
      const a = (
        await io.ask(
          `An open report has this title: #${dup.number} ${dup.title} ${dup.url}\n[a]dd to it, file a [n]ew one, or [c]ancel? `,
        )
      )
        .trim()
        .toLowerCase();
      if (a === "a") extra = { addTo: dup.number };
      else if (a === "n") extra = { fileNew: true };
      else {
        io.out("Not sent.\n");
        return 1;
      }
      continue;
    }
    const link =
      typeof r.data.newIssueUrl === "string"
        ? `\nOr file it in a browser: ${r.data.newIssueUrl}`
        : "";
    if (r.status === 409 && r.data.need === "github")
      return fail(
        `sending needs GitHub: sign in with \`gh auth login\`, then run this again. Nothing was sent.${link}`,
      );
    return fail(
      `${String(r.data.error ?? `the web app answered ${r.status}`)}${link}`,
    );
  }
}
