/**
 * Service aliases: a service's manifest key, or a compose stack's name,
 * addresses that service when it is unambiguous across the workspace
 * (`<cli> restart indexer` where `indexer` is the manifest key of the
 * repo `docs-stack`). The repo name and listed addresses still win; an
 * ambiguous alias resolves to nothing and the error names the candidates.
 * Real resolveService over a throwaway distribution.
 */

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type Runner =
  typeof import("../../../src/shared/environment-manager/service-runner.js");
let runner: Runner;
let tmp: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const up = "    commands:\n      local:\n        up: true\n";

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-alias-"));
  const distRoot = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  const names = ["docs-stack", "kb", "one", "two", "vec", "shop"];

  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  write(path.join(distRoot, "config", "den.yml"), "repos_root: ../repos\n");
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    // billing: in the catalog, not in the workspace.
    [...names, "billing"].map((n) => `${n}:\n  gh: x/${n}\n`).join(""),
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active: default",
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

  // Single-service repo whose one key is not the repo name.
  write(
    path.join(repos, "docs-stack", ".den.yml"),
    `name: docs-stack\nservices:\n  indexer:\n${up}`,
  );
  // Compose stack named apart from the repo; entrypoint api.
  write(
    path.join(repos, "kb", ".den.yml"),
    `name: kb\nentrypoint: api\ncompose:\n  name: search\nservices:\n  api:\n${up}  db:\n${up}`,
  );
  // Two repos with a `worker` each: ambiguous.
  for (const r of ["one", "two"])
    write(
      path.join(repos, r, ".den.yml"),
      `name: ${r}\nservices:\n  api:\n${up}  worker:\n${up}`,
    );
  // A stack and a service of the same repo share a name: one match.
  write(
    path.join(repos, "vec", ".den.yml"),
    `name: vec\nentrypoint: api\ncompose:\n  name: vecdb\nservices:\n  api:\n${up}  vecdb:\n${up}  shop:\n${up}`,
  );
  // A repo named like another repo's service: the repo name wins. So does
  // a catalog repo outside the workspace (two has a `billing` service).
  write(
    path.join(repos, "two", ".den.yml"),
    `name: two\nservices:\n  api:\n${up}  worker:\n${up}  billing:\n${up}`,
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    `name: shop\nservices:\n  web:\n${up}`,
  );

  process.env.DEN_ROOT = distRoot;
  delete process.env.DEN_INVOKE_CWD;
  runner =
    await import("../../../src/shared/environment-manager/service-runner.js");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.DEN_ROOT;
});

const at = (addr: string) => {
  const r = runner.resolveService(addr, "default");
  return r ? { address: r.address, subsystem: r.subsystem } : null;
};

describe("service aliases", () => {
  it("resolves a manifest service key to its service", () => {
    expect(at("indexer")).toEqual({
      address: "docs-stack",
      subsystem: "indexer",
    });
    expect(at("worker")).toBeNull(); // ambiguous; see below
  });

  it("resolves a compose stack's name to its repo's entrypoint", () => {
    expect(at("search")).toEqual({ address: "kb", subsystem: "api" });
  });

  it("treats a stack and a service of one repo with one name as one match", () => {
    expect(at("vecdb")).toEqual({ address: "vec/vecdb", subsystem: "vecdb" });
  });

  it("keeps the repo name and listed addresses first", () => {
    expect(at("shop")).toEqual({ address: "shop", subsystem: "web" });
    expect(at("kb")).toEqual({ address: "kb", subsystem: "api" });
    expect(at("billing")).toBeNull();
    expect(runner.canonicalServiceAddress("billing", "default")).toBe(
      "billing",
    );
  });

  it("names the candidates of an ambiguous alias", () => {
    expect(runner.serviceAliasCandidates("worker", "default")).toEqual([
      "one/worker",
      "two/worker",
    ]);
    expect(() => runner.canonicalServiceAddress("worker", "default")).toThrow(
      /"worker" is ambiguous in project "default": one\/worker, two\/worker/,
    );
  });

  it("canonicalServiceAddress maps an alias, and passes anything else through", () => {
    expect(runner.canonicalServiceAddress("indexer", "default")).toBe(
      "docs-stack",
    );
    expect(runner.canonicalServiceAddress("search", "default")).toBe("kb");
    expect(runner.canonicalServiceAddress("shop", "default")).toBe("shop");
    expect(runner.canonicalServiceAddress("nope", "default")).toBe("nope");
  });

  it("runServiceCommand's not-found error names the candidates", async () => {
    const lines: string[] = [];
    const code = await new Promise<number>((resolve) => {
      runner.runServiceCommand({
        address: "worker",
        command: "up",
        workspace: "default",
        onLine: (l) => lines.push(l),
        onClose: resolve,
      });
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      /service "worker" not found.*ambiguous.*one\/worker, two\/worker/s,
    );
  });
});

describe("service aliases in the CLI", () => {
  const ENGINE = path.resolve(__dirname, "../../..");
  const cli = (
    ...args: string[]
  ): Promise<{ status: number | null; out: string }> =>
    new Promise((resolve) => {
      const p = spawn(path.join(ENGINE, "bin", "den"), args, {
        cwd: tmp,
        env: {
          ...process.env,
          DEN_ROOT: path.join(tmp, "den"),
          DEN_HOME: path.join(tmp, "home"),
          DEN_SECRETS_PROVIDER: "env",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      p.stderr!.on("data", (d: Buffer) => (out += d.toString()));
      p.on("close", (status) => resolve({ status, out }));
    });

  it("up --dry-run on a service key plans its repo", async () => {
    const r = await cli("up", "indexer", "--dry-run");
    expect(r.out).not.toMatch(/not found/);
    expect(r.out).toMatch(/docs-stack/);
  }, 60_000);

  it("an ambiguous alias exits 1 naming the candidates, running nothing", async () => {
    const r = await cli("restart", "worker");
    expect(r.status).toBe(1);
    expect(r.out).toMatch(
      /"worker" is ambiguous in project "default": one\/worker, two\/worker/,
    );
  }, 60_000);
});
