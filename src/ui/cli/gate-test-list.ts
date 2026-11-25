import * as path from "node:path";

const RUNNERS = new Set(["npx", "bunx", "pnpx"]);
const RUNNER_SUB: Record<string, string[]> = {
  pnpm: ["exec", "dlx"],
  yarn: ["exec", "dlx"],
  npm: ["exec"],
};

const PROGRAMS: Record<
  string,
  { sub?: string[]; select: RegExp; value: RegExp }
> = {
  jest: {
    select:
      /^(?:--testPathPattern|--testPathPatterns|--testNamePattern|-t|--selectProjects|--findRelatedTests|--listTests|--onlyChanged|-o|--changedSince|--testMatch|--runTestsByPath|--lastCommit)(?:=|$)/,
    value:
      /^(?:-c|--config|--testTimeout|--reporters|--rootDir|--shard|--maxWorkers|-w|--coverageDirectory|--outputFile|--cacheDirectory|--testEnvironment|--seed)$/,
  },
  vitest: {
    sub: ["run", "watch", "dev"],
    select: /^(?:-t|--testNamePattern|--changed|--project|--dir)(?:=|$)/,
    value:
      /^(?:-c|--config|--root|-r|--maxWorkers|--minWorkers|--reporter|--outputFile|--shard|--pool)$/,
  },
  playwright: {
    sub: ["test"],
    select: /^(?:--grep|-g|--only-changed|--last-failed|--list)(?:=|$)/,
    value:
      /^(?:-c|--config|--project|--workers|-j|--reporter|--retries|--shard|--timeout|--output|--max-failures)$/,
  },
};

const base = (w: string) => path.basename(w).replace(/\.(?:c?js|mjs)$/, "");

const RUNNER_VALUE = /^(?:-p|--package)$/;
const ENV_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn"]);
const SHELL = /[;&|<>`$()]/;
const TEST_SCRIPT = /^test(?::|$)/;

function skipFlags(argv: string[], i: number): number {
  while (i < argv.length && argv[i]!.startsWith("-")) {
    if (RUNNER_VALUE.test(argv[i]!)) i++;
    i++;
  }
  return i;
}

/** The test script a package-manager command runs, and where its own arguments start. */
function testScript(argv: string[]): { name: string; at: number } | null {
  const w0 = base(argv[0] ?? "");
  if (!PKG_MANAGERS.has(w0)) return null;
  const a1 = argv[1] ?? "";
  if (a1 === "test" || a1 === "t") return { name: "test", at: 2 };
  if ((a1 === "run" || a1 === "run-script") && TEST_SCRIPT.test(argv[2] ?? ""))
    return { name: argv[2]!, at: 3 };
  if (w0 !== "npm" && TEST_SCRIPT.test(a1)) return { name: a1, at: 2 };
  return null;
}

/**
 * The test runner a command starts with no test files and no filter, so it
 * would run every test; null when it names some, or runs no test runner.
 * `script` reads a package.json script, so `npm test` is judged by what it
 * runs. A script with shell syntax in it is not read (it runs as before).
 */
export function emptyTestList(
  argv: string[],
  script?: (name: string) => string | undefined,
): string | null {
  const viaScript = script ? testScript(argv) : null;
  if (viaScript) {
    const body = script!(viaScript.name);
    if (!body || SHELL.test(body)) return null;
    let extra = argv.slice(viaScript.at);
    if (extra[0] === "--") extra = extra.slice(1);
    return emptyTestList([...body.trim().split(/\s+/), ...extra]);
  }
  let i = 0;
  while (i < argv.length && ENV_WORD.test(argv[i]!)) i++;
  if (base(argv[i] ?? "") === "cross-env") {
    i++;
    while (i < argv.length && ENV_WORD.test(argv[i]!)) i++;
  }
  const w0 = base(argv[i] ?? "");
  if (RUNNERS.has(w0) || w0 === "node") i = skipFlags(argv, i + 1);
  else if (RUNNER_SUB[w0]?.includes(argv[i + 1] ?? ""))
    i = skipFlags(argv, i + 2);
  const name = base(argv[i] ?? "");
  const p = PROGRAMS[name];
  if (!p) return null;
  i++;
  if (p.sub) {
    if (name === "playwright" && argv[i] !== "test") return null;
    if (p.sub.includes(argv[i] ?? "")) i++;
  }
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") continue;
    if (p.select.test(a)) return null;
    if (a.startsWith("-")) {
      if (p.value.test(a)) i++;
      continue;
    }
    return null;
  }
  return name;
}
