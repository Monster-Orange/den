/**
 * `den suites`: run the test suites each repo declares in its manifest.
 *
 *   tsx src/pillars/suites/run.ts --env local [--suite repo/name ...]
 *
 * A suite is a shell command run from the repo's checkout (or `cwd` under
 * it). It gets DEN_ENV and BASE_URL (the repo entrypoint's URL for the env).
 * Local only unless the suite lists other environments; prod never.
 */

import { spawn } from "child_process";
import * as path from "path";
import { openUrlFor } from "../../shared/manifest/service-links.js";
import { listServicesWithManifests } from "../../shared/manifest/workspace-manifests.js";
import type { Environment, TestSuiteConfig } from "../../shared/types/index.js";

import { product } from "../../shared/product.js";
import { NOTHING_RAN_EXIT } from "../../shared/run-outcome.js";
export interface PlannedSuite {
  id: string;
  repo: string;
  name: string;
  label: string;
  cmd: string;
  cwd: string;
  baseUrl: string | null;
}

export function suiteRefusal(
  suite: TestSuiteConfig,
  env: Environment,
): string | null {
  if (env === "prod" || env === "production")
    return `${product().title} never runs suites against production`;
  const allowed = suite.environments ?? ["local"];
  return allowed.includes(env)
    ? null
    : `declared for ${allowed.join(", ")} only`;
}

/** Every repo suite runnable on env; `only` narrows to repo/name or repo. */
export function planSuites(
  services: ReturnType<typeof listServicesWithManifests>,
  env: Environment,
  only: string[] = [],
): { run: PlannedSuite[]; skipped: Array<{ id: string; why: string }> } {
  const run: PlannedSuite[] = [];
  const skipped: Array<{ id: string; why: string }> = [];
  const seen = new Set<string>();
  for (const s of services) {
    if (seen.has(s.repo)) continue;
    seen.add(s.repo);
    const entry = s.manifest.entrypoint
      ? s.manifest.services?.[s.manifest.entrypoint]
      : undefined;
    for (const [name, suite] of Object.entries(s.manifest.tests ?? {})) {
      const id = `${s.repo}/${name}`;
      if (only.length && !only.includes(id) && !only.includes(s.repo)) continue;
      const why = suiteRefusal(suite, env);
      if (why) {
        skipped.push({ id, why });
        continue;
      }
      const cwd = path.resolve(s.repoPath, suite.cwd ?? ".");
      const root = path.resolve(s.repoPath);
      if (cwd !== root && !cwd.startsWith(root + path.sep)) {
        skipped.push({ id, why: "cwd leaves the checkout" });
        continue;
      }
      run.push({
        id,
        repo: s.repo,
        name,
        label: suite.label ?? name,
        cmd: suite.cmd,
        cwd,
        baseUrl: openUrlFor(entry, env),
      });
    }
  }
  return { run, skipped };
}

function runSuite(s: PlannedSuite, env: Environment): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", s.cmd], {
      cwd: s.cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        DEN_ENV: env,
        ...(s.baseUrl ? { BASE_URL: s.baseUrl } : {}),
      },
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const i = argv.indexOf("--env");
  const env = (
    i >= 0 && argv[i + 1]
      ? argv[i + 1]
      : (argv.find((a) => a.startsWith("--env="))?.slice(6) ?? "local")
  ) as Environment;
  const only: string[] = [];
  argv.forEach((a, i) => {
    if (a === "--suite" && argv[i + 1]) only.push(argv[i + 1]);
    else if (a.startsWith("--suite=")) only.push(a.slice(8));
  });

  const { run, skipped } = planSuites(listServicesWithManifests(), env, only);
  for (const s of skipped) console.log(`– ${s.id}: skipped (${s.why})`);
  // Nothing ran is its own result, never a pass (0.4.45).
  if (run.length === 0) {
    console.log(
      skipped.length
        ? `\nNothing ran: every suite was skipped on ${env}.`
        : only.length
          ? `\nNothing ran: no suite matches ${only.join(", ")}.`
          : `\nNothing ran: no repo suite to run on ${env}. Declare them under tests: in ${product().manifestYml}.`,
    );
    return NOTHING_RAN_EXIT;
  }
  const results: Array<{ id: string; code: number; ms: number }> = [];
  for (const s of run) {
    console.log(`\n▶ ${s.id}: ${s.cmd}  (in ${s.cwd})`);
    const t0 = Date.now();
    const code = await runSuite(s, env);
    results.push({ id: s.id, code, ms: Date.now() - t0 });
    console.log(`${code === 0 ? "✓" : "✗"} ${s.id} exited ${code}`);
  }
  console.log("\nSuites:");
  for (const r of results)
    console.log(
      `  ${r.code === 0 ? "✓" : "✗"} ${r.id}  ${(r.ms / 1000).toFixed(1)}s`,
    );
  return results.some((r) => r.code !== 0) ? 1 : 0;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).includes("pillars/suites/run");
if (isDirectRun) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`✗ ${(err as Error).message}`);
      process.exit(2);
    },
  );
}
