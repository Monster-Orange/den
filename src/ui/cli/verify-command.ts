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
 * count caps in verify.import. A person's: an agent is refused. It writes the same records the page reads, so no
 * server is needed.
 */
import * as fs from "fs";
import { isAgentEnv } from "./gate-command.js";
import {
  importRecord,
  parseGateVerdict,
  readImportSettings,
} from "../../shared/verify/imports.js";
import {
  readRunRecord,
  removeRunRecord,
  writeRunRecord,
} from "../../shared/verify/records.js";
import { product } from "../../shared/product.js";

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

  if (sub === "remove") {
    const rec = readRunRecord(stateDir, project, pos[0]);
    if (!rec) {
      err(`there is no run "${pos[0]}" in project ${project}`);
      return 1;
    }
    if (rec.source !== "import") {
      err(`"${pos[0]}" is not an imported run: Den keeps its own runs`);
      return 1;
    }
    removeRunRecord(stateDir, project, pos[0]);
    out(`Removed ${pos[0]} (${rec.env}) from project ${project}.`);
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
  if (org.includes(env)) {
    err(
      `"${env}" is one of Den's own environments: verify.environments can't name it. Give the imported environment its own name (like bed).`,
    );
    return 1;
  }
  if (!settings.environments.includes(env)) {
    err(
      `"${env}" is not an imported environment: add it to verify.environments in Den's config (now: ${settings.environments.join(", ") || "none"})`,
    );
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
  const v = parseGateVerdict(text, settings);
  if (!v.ok) {
    err(`nothing kept: ${v.error}`);
    return 1;
  }
  // An import replaces only its own tag's earlier import on this environment.
  const was = readRunRecord(stateDir, project, v.verdict.tag);
  if (was && was.source !== "import") {
    err(
      `nothing kept: "${v.verdict.tag}" is already one of Den's runs in project ${project}`,
    );
    return 1;
  }
  if (was && was.env !== env) {
    err(
      `nothing kept: "${v.verdict.tag}" is already imported to ${was.env}. Remove it there first (${cli} verify remove ${v.verdict.tag} --project ${project}).`,
    );
    return 1;
  }
  const rec = importRecord(project, env, v.verdict);
  writeRunRecord(stateDir, rec);
  const n = {
    passed: 0,
    failed: 0,
    error: 0,
    "needs-person": 0,
    "cant-run": 0,
  };
  let total = 0;
  for (const m of rec.modules)
    for (const c of m.clauses ?? []) {
      n[c.result]++;
      total++;
    }
  const parts = [
    n.passed && `${n.passed} passed`,
    n.failed && `${n.failed} failed`,
    n.error && `${n.error} errored`,
    n["needs-person"] && `${n["needs-person"]} need a person`,
    n["cant-run"] && `${n["cant-run"]} couldn't run`,
  ].filter(Boolean);
  out(
    `${rec.runId} on ${env}: ${rec.verdict} · ${rec.modules.length} checks, ${total} clauses (${parts.join(", ")})`,
  );
  return 0;
}
