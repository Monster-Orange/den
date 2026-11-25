/**
 * Issue 1182: keeping an outside runner's verdict as a Verify run, and
 * removing an imported run. One set of checks for the server's routes
 * (POST /api/verify/import and /api/verify/remove) and for the CLI when no
 * server is listening (issue 441's `verify import` and `verify remove`).
 */
import {
  importRecord,
  parseGateVerdict,
  type ImportSettings,
} from "./imports.js";
import { readRunRecord, removeRunRecord, writeRunRecord } from "./records.js";

export type VerifyWrite =
  | { ok: true; summary: string; runId: string }
  | { ok: false; error: string };

/** Why `env` can't take an import (null when it can). */
export function importEnvRefusal(
  env: string,
  settings: ImportSettings,
  orgEnvs: readonly string[],
): string | null {
  if (orgEnvs.includes(env))
    return `"${env}" is one of Den's own environments: verify.environments can't name it. Give the imported environment its own name (like bed).`;
  if (!settings.environments.includes(env))
    return `"${env}" is not an imported environment: add it to verify.environments in Den's config (now: ${settings.environments.join(", ") || "none"})`;
  return null;
}

/**
 * Checks `text` (the verdict file, untrusted) and keeps it as a run of
 * `project` on the imported environment `env`. `orgEnvs` are Den's own
 * environments: an imported one can't take their names. `cli` names the
 * command in the hint to remove an earlier import.
 */
export function importVerifyRun(o: {
  stateDir: string;
  project: string;
  env: string;
  text: string;
  settings: ImportSettings;
  orgEnvs: readonly string[];
  cli: string;
}): VerifyWrite {
  const { stateDir, project, env, settings } = o;
  const bad = importEnvRefusal(env, settings, o.orgEnvs);
  if (bad) return { ok: false, error: bad };
  if (Buffer.byteLength(o.text, "utf8") > settings.maxBytes)
    return {
      ok: false,
      error: `the file is over ${settings.maxBytes} bytes (verify.import.max_bytes)`,
    };
  const v = parseGateVerdict(o.text, settings);
  if (!v.ok) return { ok: false, error: `nothing kept: ${v.error}` };
  // An import replaces only its own tag's earlier import on this environment.
  const was = readRunRecord(stateDir, project, v.verdict.tag);
  if (was && was.source !== "import")
    return {
      ok: false,
      error: `nothing kept: "${v.verdict.tag}" is already one of Den's runs in project ${project}`,
    };
  if (was && was.env !== env)
    return {
      ok: false,
      error: `nothing kept: "${v.verdict.tag}" is already imported to ${was.env}. Remove it there first (${o.cli} verify remove ${v.verdict.tag} --project ${project}).`,
    };
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
  return {
    ok: true,
    runId: rec.runId,
    summary: `${rec.runId} on ${env}: ${rec.verdict} · ${rec.modules.length} checks, ${total} clauses (${parts.join(", ")})`,
  };
}

/** Removes the imported run `runId` of `project`; Den's own runs stay. */
export function removeImportedVerifyRun(o: {
  stateDir: string;
  project: string;
  runId: string;
}): VerifyWrite {
  const rec = readRunRecord(o.stateDir, o.project, o.runId);
  if (!rec)
    return {
      ok: false,
      error: `there is no run "${o.runId}" in project ${o.project}`,
    };
  if (rec.source !== "import")
    return {
      ok: false,
      error: `"${o.runId}" is not an imported run: Den keeps its own runs`,
    };
  removeRunRecord(o.stateDir, o.project, o.runId);
  return {
    ok: true,
    runId: o.runId,
    summary: `Removed ${o.runId} (${rec.env}) from project ${o.project}.`,
  };
}
