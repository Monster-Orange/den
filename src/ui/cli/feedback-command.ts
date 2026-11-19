/**
 * FB (den#81): `<cli> feedback`, Report an issue from a shell. It uses the
 * page's own routes on this install's web server, as the person: the
 * server's preview (/api/report/preview) is printed, exactly what will be
 * posted, with the target's label and warning as the form shows them,
 * then y/N, then /api/report/send. Off a terminal it is refused unless
 * --yes.
 *
 * Issue 565: `<cli> report` is the same command. From an agent's shell (an
 * agent token) it asks for the held write `report` (POST /api/approvals,
 * report-held.ts): to a public target the person's Allow, always; to a
 * private one the approval policy. The agent never sends it itself.
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
  usage: "report [--title <t>] [--kind bug|idea|question] [options]",
  lines: [
    "Report an issue from a shell, the same as Report on any page (also",
    "`feedback`). Prints exactly what will be posted, secrets and names",
    "taken out, and who can see it, then asks before filing it on GitHub.",
    "  --description <text> | --description-file <path|->",
    "  --repo <owner/repo>   where it goes (default: the first target)",
    "  --targets             list the targets and who can see each",
    "  --screenshot <path>   an image to attach to the issue by hand after",
    "  --no-redact           keep host names and paths (on by default)",
    "  --add-to <n> | --new  when an open report has the same title",
    "  --preview             print it, send nothing",
    "  --yes                 send without asking (needed off a terminal)",
    "From an agent: the person allows it in the browser first (always for",
    "a public target). Report off or GitHub unreachable: file a GitHub",
    "issue instead (the new-issue link is given).",
  ],
};

/**
 * Issue 565: each target's label and the line about who can see it: the
 * Report form's own words (the UI kit's kit.report.pub, .priv, .int,
 * .pubW and .privN), word for word.
 */
export const TARGET_WORDS = {
  public: "Public repository",
  private: "Private repository",
  internal: "Internal repository",
  publicWarning:
    "Screenshots and text are visible to everyone. Mask anything private.",
  privateNote: "Only people with access to this repository can see it.",
} as const;

type Visibility = "public" | "private" | "internal";
const visOf = (v: unknown): Visibility =>
  v === "private" || v === "internal" ? v : "public";
const labelOf = (v: Visibility): string => TARGET_WORDS[v];
/** The form's line above Send, as one line. */
const seeLine = (v: Visibility): string =>
  `${labelOf(v)}. ${v === "public" ? TARGET_WORDS.publicWarning : TARGET_WORDS.privateNote}`;

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
    "--screenshot",
  ];
  const FLAGS = ["--no-redact", "--new", "--preview", "--yes", "--targets"];
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
  const getInfo = async (): Promise<
    { status: number; data: Record<string, unknown> } | number
  > => {
    try {
      const info = await io.api("GET", "/api/report");
      if (info.status !== 200)
        return fail(
          String(info.data.error ?? `the web app answered ${info.status}`),
        );
      return info;
    } catch {
      return fail(
        `the web app is not running, so the report can't be made. Start it (\`${cli} web up\`) and try again, or file a GitHub issue instead.`,
      );
    }
  };
  const targetsOf = (data: Record<string, unknown>) =>
    Array.isArray(data.repos)
      ? (data.repos as { repo?: unknown; visibility?: unknown }[])
          .filter(
            (r): r is { repo: string; visibility?: unknown } =>
              typeof r.repo === "string",
          )
          .map((r) => ({ repo: r.repo, visibility: visOf(r.visibility) }))
      : [];
  // Issue 565: the targets and their labels, as the form shows them.
  if (flags.has("--targets")) {
    const info = await getInfo();
    if (typeof info === "number") return info;
    for (const t of targetsOf(info.data))
      io.out(`${t.repo}  ${seeLine(t.visibility)}\n`);
    return 0;
  }
  // Issue 565: an agent asks for the held write; the person allows it.
  const agent = isAgentTokenEnv(io.env);
  const yes = flags.has("--yes");
  const preview = flags.has("--preview");
  if (!agent && !io.tty && !yes && !preview)
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

  const info = await getInfo();
  if (typeof info === "number") return info;
  const targets = targetsOf(info.data);
  const repos = targets.map((t) => t.repo);
  const repo = opt["--repo"] ?? repos[0];
  if (!repo || !repos.includes(repo))
    return fail(
      `--repo is one of this install's destinations: ${repos.join(", ") || "none"}`,
      2,
    );
  const visibility =
    targets.find((t) => t.repo === repo)?.visibility ?? "public";
  const shot = opt["--screenshot"];

  if (agent) {
    // Issue 565: the held write `report` (report-held.ts). The server
    // composes, scrubs and shows the person exactly what will be posted.
    let r: { status: number; data: Record<string, unknown> };
    try {
      r = await io.api("POST", "/api/approvals", {
        action: "report",
        args: {
          kind,
          title,
          description: description ?? "",
          repo,
          redact: !flags.has("--no-redact"),
          ...(shot !== undefined ? { screenshot: shot } : {}),
          ...(addTo !== undefined ? { add_to: addTo } : {}),
          ...(flags.has("--new") ? { file_new: true } : {}),
        },
      });
    } catch {
      return fail(
        `the web app is not running, so the report can't be made. File a GitHub issue instead.`,
      );
    }
    if (r.status !== 202)
      return fail(String(r.data.error ?? `the web app answered ${r.status}`));
    const id = String(r.data.id ?? "");
    if (r.data.state === "done") {
      const res = (r.data.result ?? {}) as Record<string, unknown>;
      if (res.ok !== true)
        return fail(
          `${String(res.error ?? "it wasn't filed")}${typeof res.newIssueUrl === "string" ? `\nOr file a GitHub issue: ${res.newIssueUrl}` : ""}`,
        );
      io.out(`✓ Filed: ${String(res.url ?? "")}\n`);
      if (typeof res.next === "string") io.out(`${res.next}\n`);
      return 0;
    }
    if (r.data.state !== "pending")
      return fail(`the request ended ${String(r.data.state)} (${id})`);
    io.out(
      `To: ${repo} (${seeLine(visibility)})\nThe report waits for the person's Allow in Den's browser (request ${id}). Nothing is sent until they allow it.\n`,
    );
    return 0;
  }

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
    `To: ${repo} (${seeLine(visibility)})\nTitle: ${String(p.data.title)}\n\n${String(p.data.body)}\n\n${shot !== undefined ? `Screenshot: ${shot} (not scrubbed: look at it first; attach it to the issue by hand after)\n\n` : ""}`,
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
      if (shot !== undefined)
        io.out(
          `Attach the screenshot (${shot}) to it by hand: GitHub's issue API takes no images.\n`,
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

/** Issue 565: `<cli> report`, the same command as `feedback`. */
export const cmdReport = cmdFeedback;
