import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";

// workspaces.ts and catalog.ts fix their file paths from the Den root at load
// time, so the modules are loaded fresh with DEN_ROOT on a scratch root. They
// would otherwise write this checkout's real config/local files.
const distRoot = fs.mkdtempSync(path.join(os.tmpdir(), "den-register-"));
const savedRoot = process.env.DEN_ROOT;
let registerLocalRepo: typeof import("../../../src/shared/environment-manager/register-local.js").registerLocalRepo;

function checkout(name: string, manifest: string | null): string {
  const dir = path.join(distRoot, "elsewhere", name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", [
    "-C",
    dir,
    "remote",
    "add",
    "origin",
    `git@github.com:Acme/${name}.git`,
  ]);
  if (manifest) fs.writeFileSync(path.join(dir, ".den.yml"), manifest);
  return dir;
}
const read = (f: string): Record<string, unknown> =>
  yaml.parse(
    fs.readFileSync(path.join(distRoot, "config", "local", f), "utf-8"),
  );

beforeAll(async () => {
  fs.mkdirSync(path.join(distRoot, "config", "local"), { recursive: true });
  fs.writeFileSync(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    "active: [default]\nfocus: default\nworkspaces:\n  default:\n    services: {}\n",
  );
  fs.writeFileSync(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  process.env.DEN_ROOT = distRoot;
  jest.resetModules();
  ({ registerLocalRepo } =
    await import("../../../src/shared/environment-manager/register-local.js"));
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(distRoot, { recursive: true, force: true });
});

describe("registerLocalRepo", () => {
  it("writes only under the scratch Den root", async () => {
    const { getDistRoot } = await import("../../../src/shared/paths.js");
    expect(getDistRoot()).toBe(distRoot);
  });

  it("adds a checkout outside the repos root under its manifest name", () => {
    const dir = checkout("arbor", "name: acme-arbor\nservices:\n  api: {}\n");
    const r = registerLocalRepo(dir, "default");
    expect(r).toEqual({
      repoName: "acme-arbor",
      gh: "Acme/arbor",
      path: dir,
      services: ["api"],
    });
    const ws = read("workspaces.yml") as {
      workspaces: { default: { services: Record<string, unknown> } };
    };
    expect(ws.workspaces.default.services["acme-arbor"]).toEqual({
      mode: "dev-managed",
      path: dir,
    });
    expect(read("service-catalog.yml")["acme-arbor"]).toEqual({
      gh: "Acme/arbor",
    });
  });

  it("adds a multi-service repo as one entry, replacing old ones", () => {
    const dir = checkout(
      "maps",
      "name: hooli-maps\nservices:\n  app: {}\n  mail: {}\n",
    );
    registerLocalRepo(dir, "default");
    const again = registerLocalRepo(dir, "default");
    expect(again.services).toEqual(["app", "mail"]);
    const ws = read("workspaces.yml") as {
      workspaces: { default: { services: Record<string, unknown> } };
    };
    expect(
      Object.keys(ws.workspaces.default.services).filter((k) =>
        k.startsWith("hooli-maps"),
      ),
    ).toEqual(["hooli-maps"]);
  });

  it("refuses a checkout with no manifest", () => {
    expect(() => registerLocalRepo(checkout("bare", null), "default")).toThrow(
      /No \.den\.yml/,
    );
  });
});
