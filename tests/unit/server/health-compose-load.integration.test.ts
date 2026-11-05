/**
 * Den's own compose-stack health checks are answered in-process from one
 * docker listing per health cycle: no `<cli> stack health` process per
 * check. Before, 17 compose services meant 17 tsx CLI starts (each running
 * its own `docker ps`) per cycle; on a loaded machine they ran past their 5s
 * budget, and two such cycles in a row read every stack down.
 *
 * Real web server, throwaway distribution: three compose repos with 17
 * manifest services between them, a `docker` shim and a `bin/den` wrapper
 * that log each start, and CPU burners running through the cycles.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import {
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

const ENGINE = path.resolve(__dirname, "../../..");
/** Stack → its manifest services (17 in all). */
const STACKS: Record<string, string[]> = {
  alpha: ["app", "api", "worker", "db", "cache", "search"],
  beta: ["app", "api", "worker", "db", "cache", "queue"],
  gamma: ["app", "api", "db", "cache", "jobs"],
};

let tmp = "";
let srv: SlowGitServer;
const burners: ChildProcess[] = [];
const lines = (f: string): number =>
  fs.existsSync(f)
    ? fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).length
    : 0;
const cliLog = () => path.join(tmp, "cli-starts.log");
const dockerLog = () => path.join(tmp, "docker-calls.log");

interface Result {
  repo: string;
  service: string;
  ok: boolean | null;
}

function stream(port: number): Promise<{ ms: number; results: Result[] }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const results: Result[] = [];
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/health/stream?refresh=1",
        agent: false,
        timeout: 60_000,
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => {
          buf += d.toString();
          let i;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const msg = JSON.parse(buf.slice(0, i).replace(/^data: /, "")) as {
              type: string;
              result?: Result;
            };
            buf = buf.slice(i + 2);
            if (msg.type === "result" && msg.result) results.push(msg.result);
          }
        });
        res.on("end", () => resolve({ ms: Date.now() - started, results }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("stream timeout")));
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-compose-load-"));
  const root = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nedge:\n  org: acme\n  domain: acme.localhost\n",
  );
  // The CLI the generated checks would run: log each start, then run it.
  write(
    path.join(root, "bin", "den"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(cliLog())}\nexec ${JSON.stringify(path.join(ENGINE, "bin", "den"))} "$@"\n`,
    0o755,
  );
  const names = Object.keys(STACKS);
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    names.map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...names.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  const rows: string[][] = [];
  for (const [n, services] of Object.entries(STACKS)) {
    write(
      path.join(repos, n, ".den.yml"),
      [
        `name: ${n}`,
        "entrypoint: app",
        "compose:",
        `  name: ${n}`,
        "services:",
        ...services.map((s) => `  ${s}: {}`),
        "",
      ].join("\n"),
    );
    write(path.join(repos, n, "docker-compose.yml"), "services: {}\n");
    for (const s of services)
      rows.push([`${n}-main`, s, "running", "Up 2 hours (healthy)"]);
  }
  // A docker that answers `ps` as the real one would: the listing of every
  // compose container, or (the per-check query `stack health` makes) the
  // rows matching its project/service label filters, three columns.
  write(
    path.join(tmp, "shim", "docker"),
    [
      `#!${process.execPath}`,
      `require("fs").appendFileSync(${JSON.stringify(dockerLog())}, process.argv.slice(2).join(" ") + "\\n");`,
      `const rows = ${JSON.stringify(rows)};`,
      "const args = process.argv.slice(2);",
      "const want = (k) => args.map((a) => a.match(new RegExp('^label=com\\\\.docker\\\\.compose\\\\.' + k + '=(.*)$'))).find(Boolean)?.[1];",
      "const project = want('project'), service = want('service');",
      "const mine = rows.filter((r) => (!project || r[0] === project) && (!service || r[1] === service));",
      "process.stdout.write(mine.map((r) => (project ? r.slice(1) : r).join('\\t') + '\\n').join(''));",
      "",
    ].join("\n"),
    0o755,
  );
  const savedPath = process.env.PATH;
  process.env.PATH = `${path.join(tmp, "shim")}:${savedPath ?? ""}`;
  try {
    srv = await startSlowGitServer({ tmp, root, slow: [], delayS: 0 });
  } finally {
    process.env.PATH = savedPath;
  }
  // Induced load for the cycles below: one busy loop per two cores.
  for (let i = 0; i < Math.max(2, Math.floor(os.cpus().length / 2)); i++)
    burners.push(
      spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }),
    );
}, 180_000);

afterAll(async () => {
  for (const b of burners) b.kill("SIGKILL");
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("compose health under load", () => {
  it("17 compose checks: no CLI start, one docker listing per cycle, none down, well under budget", async () => {
    const startsBefore = lines(cliLog());
    const dockerBefore = lines(dockerLog());
    const first = await stream(srv.port);
    const second = await stream(srv.port);
    const cliStarts = lines(cliLog()) - startsBefore;
    const dockerCalls = lines(dockerLog()) - dockerBefore;
    console.log(
      `per 2 cycles: ${cliStarts} CLI starts, ${dockerCalls} docker calls; cycles ${first.ms}ms, ${second.ms}ms`,
    );

    for (const cycle of [first, second]) {
      expect(cycle.results).toHaveLength(17);
      expect(cycle.results.filter((r) => r.ok !== true)).toEqual([]);
      // The budget a check has is 5s; the cycle must not need it.
      expect(cycle.ms).toBeLessThan(2_500);
    }
    expect(cliStarts).toBe(0);
    expect(dockerCalls).toBe(2);
  }, 180_000);
});
