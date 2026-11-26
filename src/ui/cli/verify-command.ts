/**
 * Issue 441: `<cli> verify`, Verify's results from a shell.
 *
 *   import <file> --env <env> --project <p>   an outside runner's gate
 *       results (one verdict file per build, the shape of a repo's live
 *       checks: CONTRIBUTING.md, "Live checks") kept as a Verify run on an
 *       imported environment (the org config's verify.environments)
 *   remove <run> --project <p>                an imported run, gone
 *
 * The file is untrusted: verify/imports.ts checks it, with the size and
 * count caps in verify.import. A person's: an agent is refused.
 *
 * Issue 1182: the change goes through the running server (POST
 * /api/verify/import and /api/verify/remove, which refuse agents), audited
 * as the person. With no server listening, the CLI writes the records
 * itself (shared/verify/import-run.ts, the same checks).
 */
import * as fs from "fs";
import { isAgentEnv } from "./gate-command.js";
import { readImportSettings } from "../../shared/verify/imports.js";
import {
  importEnvRefusal,
  importVerifyRun,
  removeImportedVerifyRun,
} from "../../shared/verify/import-run.js";
import { product } from "../../shared/product.js";
import {
  personServerFor,
  throughServer,
  type PersonServer,
} from "./person-server.js";

export const VERIFY_HELP = {
  usage: "verify [import|remove]",
  lines: [
    "Verify's results from a shell.",
    "  import <file> --env <env> --project <p>   keep an outside runner's gate results",
    "                                            as a run (env: one of verify.environments)",
    "  remove <run> --project <p>                remove an imported run",
  ],
};

export interface VerifyCommandDeps {
  stateDir?: string;
  env?: Record<string, string | undefined>;
  /** The org config's `verify:` block. */
  verifyConfig?: () => unknown;
  projectExists?: (project: string) => boolean;
  /** The org's own environments: an imported one can't take their names. */
  orgEnvironments?: () => string[];
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Issue 1182: this install's server, with the person token (tests). */
  server?: PersonServer;
}

/**
 * Issue 1182: the change, sent to the running server. The server's
 * summary, "refused" (shown), or null when none is listening.
 */
async function viaServer(
  server: PersonServer,
  p: string,
  body: unknown,
  err: (l: string) => void,
): Promise<string | "refused" | null> {
  try {
    const j = await throughServer(server, "POST", p, body);
    if (j === null) return null;
    const summary = (j as { summary?: unknown }).summary;
    return typeof summary === "string" ? summary : "";
  } catch (e) {
    err(`${(e as Error).message}; nothing was changed`);
    return "refused";
  }
}

/** `--name value` from args, and the args left. */
function flags(args: readonly string[]): {
  pos: string[];
  opt: Record<string, string>;
} {
  const pos: string[] = [];
  const opt: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--(env|project)(?:=(.*))?$/.exec(a);
    if (m) opt[m[1]] = m[2] ?? args[++i] ?? "";
    else if (a === "-p") opt.project = args[++i] ?? "";
    else pos.push(a);
  }
  return { pos, opt };
}

export async function cmdVerify(
  args: readonly string[],
  deps: VerifyCommandDeps = {},
): Promise<number> {
  const cli = product().cli;
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const usage = () => {
    err(`usage: ${cli} ${VERIFY_HELP.usage}`);
    for (const l of VERIFY_HELP.lines) err(l);
    return 2;
  };
  const sub = args[0];
  const { pos, opt } = flags(args.slice(1));
  if (sub !== "import" && sub !== "remove") return usage();
  // Any agent: its token, or Den's agent marker alone (as `gate` checks).
  if (isAgentEnv(deps.env ?? process.env)) {
    err(
      `${cli} verify ${sub} is a person's: an agent can't change Verify's results.`,
    );
    return 1;
  }
  const project = opt.project;
  if (!pos[0] || !project || (sub === "import" && !opt.env)) return usage();
  let exists = deps.projectExists;
  if (!exists) {
    // The projects' config only when a command needs it.
    const w = await import("../../shared/environment-manager/workspaces.js");
    exists = (p: string) => !!w.getWorkspaceByName(p);
  }
  if (!exists(project)) {
    err(`there is no project "${project}"`);
    return 1;
  }
  const stateDir =
    deps.stateDir ?? (await import("../../shared/paths.js")).getStateDir();

  const server = deps.server ?? personServerFor(stateDir);

  if (sub === "remove") {
    const via = await viaServer(
      server,
      "/api/verify/remove",
      { project, run: pos[0] },
      err,
    );
    if (via === "refused") return 1;
    if (via !== null) {
      if (via) out(via);
      return 0;
    }
    const r = removeImportedVerifyRun({ stateDir, project, runId: pos[0] });
    if (!r.ok) {
      err(r.error);
      return 1;
    }
    out(r.summary);
    return 0;
  }

  let settings;
  try {
    const raw =
      deps.verifyConfig?.() ??
      (await import("../../shared/den-config.js")).readDenConfig().verify;
    settings = readImportSettings(raw);
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  const env = opt.env;
  const org =
    deps.orgEnvironments?.() ??
    (await import("../../shared/den-config.js")).orgEnvironments();
  const badEnv = importEnvRefusal(env, settings, org);
  if (badEnv) {
    err(badEnv);
    return 1;
  }
  let text: string;
  try {
    const st = fs.statSync(pos[0]);
    // A FIFO or a device says size 0, then reads without end.
    if (!st.isFile()) {
      err(`can't read ${pos[0]}: not a regular file`);
      return 1;
    }
    if (st.size > settings.maxBytes) {
      err(
        `the file is over ${settings.maxBytes} bytes (verify.import.max_bytes)`,
      );
      return 1;
    }
    text = fs.readFileSync(pos[0], "utf-8");
  } catch (e) {
    err(`can't read ${pos[0]}: ${(e as Error).message}`);
    return 1;
  }
  const via = await viaServer(
    server,
    "/api/verify/import",
    { project, env, text },
    err,
  );
  if (via === "refused") return 1;
  if (via !== null) {
    if (via) out(via);
    return 0;
  }
  const r = importVerifyRun({
    stateDir,
    project,
    env,
    text,
    settings,
    orgEnvs: org,
    cli,
  });
  if (!r.ok) {
    err(r.error);
    return 1;
  }
  out(r.summary);
  return 0;
}
