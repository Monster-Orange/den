/**
 * WS-6 dogfood findings (0.4.5) from the command line: `down` of a shared
 * repo another workspace started, `down -a` across every workspace on
 * this machine, `switch`'s plan by the running rule, and `switch
 * --stop-others` off a terminal. The real bin/den in a throwaway
 * distribution (helpers/dist.ts) with three workspaces on this machine:
 * north (shared, alone), south (shared, extra) and west (shared). Every
 * "running" service is a `sleep` this test starts in its own process
 * group and records as Den's `up` would; none has a down command, so
 * `down` stops that group. Nothing else runs.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as path from "path";
import { recordProcessGroup } from "../../../src/shared/process/process-group.js";
import { makeDist, type Dist } from "../sessions/helpers/dist.js";

let d: Dist;
let downUrl = "";
const groups: number[] = [];

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}
/** A process group standing for `repo`'s running service, recorded for `owners`. */
function running(repos: string, owners: Record<string, string[]>): number[] {
  const daemons = [];
  const pgids: number[] = [];
  for (const repo of repos.split(",")) {
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    child.unref();
    const g = recordProcessGroup(child.pid!);
    if (!g) throw new Error("could not read the test's own process");
    groups.push(g.pgid);
    pgids.push(g.pgid);
    daemons.push({
      address: repo,
      repoName: repo,
      subsystem: repo,
      repoPath: path.join(d.tmp, "repos", repo),
      logPath: path.join(d.tmp, `${repo}.log`),
      startedAt: new Date().toISOString(),
      workspaces: owners[repo],
      pgid: g.pgid,
      pgidStartedAt: g.startedAt,
    });
  }
  write(path.join(d.tmp, "daemons.json"), JSON.stringify({ daemons }));
  return pgids;
}
async function gone(pgid: number, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pgid) && Date.now() < end)
    await new Promise((r) => setTimeout(r, 100));
  return !alive(pgid);
}

beforeAll(async () => {
  d = makeDist("den-ws6-cli-");
  d.env.DEN_HOME = path.join(d.tmp, "den-home");
  downUrl = `http://localhost:${await freePort()}/health`;
  const WS: [string, string[]][] = [
    ["north", ["shared", "alone"]],
    ["south", ["shared", "extra"]],
    ["west", ["shared"]],
  ];
  write(
    path.join(d.root, "config", "local", "service-catalog.yml"),
    ["shared", "alone", "extra"]
      .map((r) => `${r}:\n  gh: acme/${r}\n`)
      .join(""),
  );
  write(
    path.join(d.root, "config", "local", "workspaces.yml"),
    [
      "active: [north, south, west]",
      "focus: south",
      "workspaces:",
      ...WS.flatMap(([ws, rs]) => [
        `  ${ws}:`,
        "    services:",
        ...rs.flatMap((r) => [
          `      ${r}:`,
          "        mode: dev-managed",
          `        path: ${path.join(d.tmp, "repos", r)}`,
        ]),
      ]),
      "",
    ].join("\n"),
  );
  for (const r of ["shared", "alone", "extra"])
    write(
      path.join(d.tmp, "repos", r, ".acme.yml"),
      [
        `name: ${r}`,
        "services:",
        `  ${r}:`,
        "    commands:",
        "      local:",
        '        up: "true"',
        "    health:",
        `      local: { type: http, url: '${downUrl}' }`,
        "",
      ].join("\n"),
    );
}, 60_000);

afterAll(() => {
  // Only the groups this test started.
  for (const g of groups)
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      /* gone */
    }
  if (d) fs.rmSync(d.tmp, { recursive: true, force: true });
});

describe("down of a shared repo (finding 2)", () => {
  it("down <repo> -w <ws> stops it when it is in <ws>, whichever workspace started it", async () => {
    const [g] = running("shared", { shared: ["north"] });
    const r = d.den(["down", "shared", "-w", "south"]);
    expect(r.code).toBe(0);
    expect(await gone(g)).toBe(true);
  }, 60_000);

  it("down -a stops every workspace's services, not only the focus's", async () => {
    const [shared, alone] = running("shared,alone", {
      shared: ["north"],
      alone: ["north"],
    });
    const r = d.den(["down", "-a"]);
    expect(r.code).toBe(0);
    expect([await gone(shared), await gone(alone)]).toEqual([true, true]);
  }, 90_000);

  it("a down that stops nothing never prints ✔: it says why", async () => {
    const [g] = running("shared", { shared: ["north", "south"] });
    const r = d.den(["down", "shared", "-w", "south"]);
    expect(r.code).toBe(0);
    expect(alive(g)).toBe(true);
    expect(r.out).not.toMatch(/✔ down shared/);
    expect(r.out).toMatch(
      /down shared \(not stopped: another workspace still uses it\)/,
    );
    expect(r.out).toContain("still running for [north]");
  }, 60_000);
});

describe("switch (findings 5 and 6)", () => {
  it("the dry run's Starts leaves out what runs (a live record), by the running rule", () => {
    running("shared", { shared: ["north"] });
    const r = d.den(["switch", "south", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Starts: what isn't running in south (extra)");
  }, 60_000);

  it("--stop-others off a terminal needs -y: exit 1, nothing changed", () => {
    const before = fs.readFileSync(
      path.join(d.root, "config", "local", "workspaces.yml"),
      "utf-8",
    );
    const r = d.den(["switch", "west", "--stop-others"], "");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/--stop-others .*can't ask here.*-y/);
    expect(
      fs.readFileSync(
        path.join(d.root, "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).toBe(before);
    expect(d.den(["switch", "--help"]).out).toMatch(/needs -y/);
  }, 60_000);
});
