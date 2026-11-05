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

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let repos = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** A docker that reports `projects` as running (or fails when null). */
function dockerShim(projects: string[] | null): string {
  const dir = fs.mkdtempSync(path.join(tmp, "shim-"));
  write(
    path.join(dir, "docker"),
    projects === null
      ? "#!/bin/sh\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n"
      : `#!/bin/sh\nprintf '%s\\n' ${projects.map((p) => `'${p}'`).join(" ")}\n`,
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

/** Two active workspaces; ws-a holds `shop`, whose stack is `shopdb`. */
function resetWorkspaces(): void {
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default, ws-a]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services: {}",
      "  ws-a:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${path.join(repos, "shop")}`,
      "",
    ].join("\n"),
  );
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-ws-deactivate-"));
  root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
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
  it("lists activate, deactivate and focus with a line each", () => {
    const out = den(["workspace", "--help"]);
    expect(out).toMatch(
      /workspace <list\|activate\|deactivate\|focus\|use\|create\|delete\|code>/,
    );
    expect(out).toMatch(/^\s+activate <n>\s+\S/m);
    expect(out).toMatch(/^\s+deactivate <n>\s+\S/m);
    expect(out).toMatch(/^\s+focus <n>\s+\S/m);
    expect(out).toMatch(
      /compose\s+stacks keep running; stop them with `den down <repo>`/,
    );
  });
});

describe("workspace deactivate", () => {
  it("names the running compose stacks it left up, and how to stop them", () => {
    resetWorkspaces();
    const out = den(
      ["workspace", "deactivate", "ws-a"],
      dockerShim(["shopdb-ws-a", "unrelated-default"]),
    );
    expect(out).toMatch(/Deactivated workspace: ws-a/);
    expect(out).toMatch(
      /compose stacks keep running \(shopdb-ws-a\): stop them with `den down shop`/,
    );
    expect(out).not.toMatch(/unrelated/);
  }, 60_000);

  it("says it generically when docker can't be asked", () => {
    resetWorkspaces();
    const out = den(["workspace", "deactivate", "ws-a"], dockerShim(null));
    expect(out).toMatch(
      /compose stacks keep running: stop them with `den down <repo>`/,
    );
  }, 60_000);

  it("says nothing about stacks when none of the workspace's is running", () => {
    resetWorkspaces();
    const out = den(
      ["workspace", "deactivate", "ws-a"],
      dockerShim(["unrelated-default"]),
    );
    expect(out).toMatch(/Deactivated workspace: ws-a/);
    expect(out).not.toMatch(/compose stacks/);
  }, 60_000);
});

describe("workspace focus", () => {
  it("focuses an active workspace", () => {
    resetWorkspaces();
    expect(den(["workspace", "focus", "ws-a"])).toMatch(
      /Focused workspace: ws-a/,
    );
    expect(
      fs.readFileSync(
        path.join(root, "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).toMatch(/focus: ws-a/);
  }, 60_000);
});
