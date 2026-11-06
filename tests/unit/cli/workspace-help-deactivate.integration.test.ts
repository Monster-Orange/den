/**
 * `<cli> workspace --help` lists every subcommand (activate, deactivate and
 * focus too), and says deactivate releases only tracked services. And
 * `workspace deactivate` says which compose stacks of the workspace's repos
 * it left running, with the command that stops them.
 *
 * Real bin/den in a throwaway distribution; `docker` is a shim on PATH.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  projectName,
  stackWorkspace,
} from "../../../src/shared/stacks/render.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let repos = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** A running Compose project as `docker ps` labels it. */
type Row = { project: string; workingDir: string };

/** A docker whose `ps` reports `rows` (or that fails, when null). */
function dockerShim(rows: Row[] | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, "shim-"));
  write(
    path.join(dir, "docker"),
    rows === null
      ? "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n"
      : `#!/bin/sh\nprintf '%s\\t%s\\n' ${rows
          .map((r) => `'${r.project}' '${r.workingDir}'`)
          .join(" ")}\n`,
    0o755,
  );
  return dir;
}

function den(args: string[], shim?: string): string {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      PATH: `${shim ? `${shim}:` : ""}${process.env.PATH ?? ""}`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return `${r.stdout}${r.stderr}`;
}

/**
 * Two active workspaces. default holds `shop`, a Den stack (`compose:` named
 * shopdb), and `site`, which runs its own compose project from `make up`.
 */
function resetWorkspaces(): void {
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default, ws-a]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...["shop", "site"].flatMap((r) => [
        `      ${r}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, r)}`,
      ]),
      "  ws-a:",
      "    services: {}",
      "",
    ].join("\n"),
  );
}

/** The project Den runs `shop`'s stack as in `default`. */
const SHOP_PROJECT = projectName("shopdb", stackWorkspace("default"));

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-ws-deactivate-"));
  root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\nsite:\n  gh: acme/site\n",
  );
  write(
    path.join(repos, "site", ".den.yml"),
    'name: site\nservices:\n  web:\n    commands:\n      local:\n        up: "make up"\n',
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    [
      "name: shop",
      "compose:",
      "  name: shopdb",
      "services:",
      "  api:",
      "    commands:",
      "      local:",
      '        up: "true"',
      "",
    ].join("\n"),
  );
  write(path.join(repos, "shop", "docker-compose.yml"), "services: {}\n");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("workspace --help", () => {
  it("lists add, remove and focus with a line each (0.4.3: activate and deactivate are their old names)", () => {
    const out = den(["workspace", "--help"]);
    expect(out).toMatch(
      /workspace <list\|add\|remove\|focus\|use\|create\|delete\|code\|seed>/,
    );
    expect(out).toMatch(/^\s+add <n>\s+\S/m);
    expect(out).toMatch(/^\s+remove <n>\s+\S/m);
    expect(out).toMatch(/^\s+focus <n\|all>\s+\S/m);
    expect(out).toMatch(/was `activate`, which still works/);
    expect(out).not.toMatch(/\(active\)/);
    expect(out).toMatch(
      /compose\s+stacks keep running; stop them with `den down <repo>`/,
    );
  });
});

describe("workspace <sub> --help", () => {
  it("prints that subcommand's help only", () => {
    const out = den(["workspace", "focus", "--help"]);
    expect(out).toMatch(/den workspace focus <n\|all>/);
    expect(out).toMatch(/default for commands/);
    expect(out).not.toMatch(/add <n>|create \[n\]/);
  });
});

describe("workspace deactivate", () => {
  it("names the running compose stacks it left up, and how to stop them", () => {
    resetWorkspaces();
    const out = den(
      ["workspace", "deactivate", "default"],
      dockerShim([
        { project: SHOP_PROJECT, workingDir: path.join(repos, "shop") },
        // Started by the repo itself, from a subdirectory of its checkout.
        { project: "site", workingDir: path.join(repos, "site", "deploy") },
        { project: "unrelated", workingDir: path.join(tmp, "elsewhere") },
      ]),
    );
    expect(SHOP_PROJECT).toBe("shopdb-main");
    expect(out).toMatch(/Off this machine: default/);
    expect(out).toMatch(
      /compose stacks keep running \(shopdb-main, site\): stop them with `den down shop`, `den down site`/,
    );
    expect(out).not.toMatch(/unrelated/);
  }, 60_000);

  it("never tells you to stop a stack another active workspace still holds", () => {
    // ws-a also holds site (same checkout): its stack is still in use.
    write(
      path.join(root, "config", "local", "workspaces.yml"),
      [
        "active: [default, ws-a]",
        "focus: default",
        "workspaces:",
        "  default:",
        "    services:",
        ...["shop", "site"].flatMap((r) => [
          `      ${r}:`,
          "        mode: dev-managed",
          `        path: ${path.join(repos, r)}`,
        ]),
        "  ws-a:",
        "    services:",
        "      site:",
        "        mode: dev-managed",
        `        path: ${path.join(repos, "site")}`,
        "",
      ].join("\n"),
    );
    const out = den(
      ["workspace", "deactivate", "default"],
      dockerShim([
        { project: SHOP_PROJECT, workingDir: path.join(repos, "shop") },
        { project: "site", workingDir: path.join(repos, "site", "deploy") },
      ]),
    );
    expect(out).toMatch(
      /compose stacks keep running \(shopdb-main\): stop them with `den down shop`/,
    );
    expect(out).toMatch(/site \(still in ws-a\)/);
    expect(out).not.toMatch(/`den down site`/);
  }, 60_000);

  it("says it generically when docker can't be asked", () => {
    resetWorkspaces();
    const out = den(["workspace", "deactivate", "default"], dockerShim(null));
    expect(out).toMatch(
      /compose stacks keep running: stop them with `den down <repo>`/,
    );
  }, 60_000);

  it("says nothing about stacks when none of the workspace's is running", () => {
    resetWorkspaces();
    const out = den(
      ["workspace", "deactivate", "default"],
      dockerShim([
        { project: "unrelated", workingDir: path.join(tmp, "elsewhere") },
      ]),
    );
    expect(out).toMatch(/Off this machine: default/);
    expect(out).not.toMatch(/compose stacks/);
  }, 60_000);
});

describe("workspace focus", () => {
  it("focuses a workspace on this machine", () => {
    resetWorkspaces();
    expect(den(["workspace", "focus", "ws-a"])).toMatch(/✓ Focus: ws-a/);
    expect(
      fs.readFileSync(
        path.join(root, "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).toMatch(/focus: ws-a/);
  }, 60_000);
});
