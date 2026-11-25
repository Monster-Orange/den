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

/**
 * The test runner a command starts with no test files and no filter, so it
 * would run every test; null when it names some, or runs no test runner.
 */
export function emptyTestList(argv: string[]): string | null {
  let i = 0;
  const w0 = base(argv[0] ?? "");
  if (RUNNERS.has(w0)) {
    i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
  } else if (RUNNER_SUB[w0]?.includes(argv[1] ?? "")) {
    i = 2;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
  } else if (w0 === "node") {
    i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) i++;
  }
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
    if (p.select.test(a)) return null;
    if (a.startsWith("-")) {
      if (p.value.test(a)) i++;
      continue;
    }
    return null;
  }
  return name;
}
