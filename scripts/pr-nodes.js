/**
 * Which Nodes a pull request's checks and install smoke run on (ci.yml's
 * pr job, its select step).
 *
 * A pull request's tests run on both Nodes: #398's replay found real
 * failures that showed on one Node only, on each of them, in the unit
 * tests and the browser specs. Its checks (typecheck, lint, the words, kit
 * and org-name gates) and the install smoke never failed on one Node
 * alone (the test-cycle audit, 4 days of runs), so a pull request runs
 * them on the lowest Node only, unless the change touches the Node or the
 * dependencies: package.json (its engines too), package-lock.json, .nvmrc,
 * or a workspace package's package.json. Then they run on every Node.
 * A push to main and the nightly run use every Node regardless.
 *
 *   node scripts/pr-nodes.js <base> <head> --nodes 22.13.0,24.13.0
 *
 * prints `check-nodes=["22.13.0"]` (a JSON matrix) and `node-change=false`,
 * for $GITHUB_OUTPUT.
 */
import { execFileSync } from "node:child_process";

/** A change to one of these runs the checks on every Node. */
export const NODE_CHANGE = [
  /^package\.json$/,
  /^package-lock\.json$/,
  /^\.nvmrc$/,
  /^\.node-version$/,
  /^packages\/[^/]+\/package\.json$/,
];

export function nodeChange(changed) {
  return changed.filter((f) => NODE_CHANGE.some((re) => re.test(f)));
}

/** The Nodes the checks run on: every Node on a Node change, else the lowest. */
export function checkNodes(changed, nodes) {
  if (!nodes.length) throw new Error("no Nodes given");
  return nodeChange(changed).length ? [...nodes] : [nodes[0]];
}

function main(argv) {
  const n = argv.indexOf("--nodes");
  const nodes = n >= 0 ? argv[n + 1].split(",").filter(Boolean) : [];
  const [base, head] = argv.filter(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--nodes",
  );
  if (!base || !head || !nodes.length) {
    console.error(
      "usage: node scripts/pr-nodes.js <base> <head> --nodes 22.13.0,24.13.0",
    );
    return 2;
  }
  const changed = execFileSync(
    "git",
    ["diff", "--name-only", `${base}...${head}`],
    { encoding: "utf-8" },
  )
    .split("\n")
    .filter(Boolean);
  const why = nodeChange(changed);
  console.log(`check-nodes=${JSON.stringify(checkNodes(changed, nodes))}`);
  console.log(`node-change=${why.length > 0}`);
  for (const f of why)
    console.error(`pr-nodes: ${f} changed: the checks run on every Node`);
  return 0;
}

if (/[\\/]pr-nodes\.js$/.test(process.argv[1] ?? ""))
  process.exitCode = main(process.argv.slice(2));
