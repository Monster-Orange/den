/**
 * The web UI's LaunchAgent must not run as a Background process: macOS
 * gives those efficiency cores and throttled I/O, so a UI people wait on
 * stalls for seconds whenever the machine is busy. `service/install.sh
 * print` writes the plist without touching launchd.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");

describe("web UI LaunchAgent plist", () => {
  it("runs as an Interactive process, never Background", () => {
    const r = spawnSync(
      "bash",
      [path.join(root, "service", "install.sh"), "print"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DEN_ROOT: path.join(root, "examples", "distribution"),
        },
      },
    );
    expect(r.status).toBe(0);
    const m = /<key>ProcessType<\/key>\s*<string>([^<]*)<\/string>/.exec(
      r.stdout,
    );
    expect(m?.[1]).toBe("Interactive");
    expect(r.stdout).not.toMatch(/<string>Background<\/string>/);
  });

  it("service status shows launchd's spawn type", () => {
    const src = fs.readFileSync(
      path.join(root, "service", "install.sh"),
      "utf-8",
    );
    const status = src.slice(src.indexOf("  status)"));
    expect(status).toMatch(/spawn type/);
  });
});

describe("the node the LaunchAgent runs", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-svc-node-"));
  /** A fake node that reports `major` for -p, at `dir/node`. */
  function fakeNode(dir: string, major: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "node");
    fs.writeFileSync(p, `#!/bin/sh\necho ${major}\n`, { mode: 0o755 });
    return p;
  }
  function print(env: Record<string, string>) {
    return spawnSync(
      "bash",
      [path.join(root, "service", "install.sh"), "print"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          DEN_ROOT: path.join(root, "examples", "distribution"),
          ...env,
        },
      },
    );
  }
  const programNode = (plist: string) =>
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(
      plist,
    )?.[1];

  it("prefers a stable node of the same major over nvm's", () => {
    const t = tmp();
    const nvm = fakeNode(
      path.join(t, ".nvm", "versions", "node", "v22.1.0", "bin"),
      "22",
    );
    const stable = fakeNode(path.join(t, "stable"), "22");
    const r = print({
      PATH: `${path.dirname(nvm)}:/usr/bin:/bin`,
      DEN_SERVICE_STABLE_NODES: stable,
    });
    expect(r.status).toBe(0);
    expect(programNode(r.stdout)).toBe(stable);
    expect(r.stderr).not.toMatch(/version manager/);
    fs.rmSync(t, { recursive: true, force: true });
  });

  it("keeps nvm's node, with a warning, when no stable one matches", () => {
    const t = tmp();
    const nvm = fakeNode(
      path.join(t, ".nvm", "versions", "node", "v22.1.0", "bin"),
      "22",
    );
    const stable = fakeNode(path.join(t, "stable"), "20");
    const r = print({
      PATH: `${path.dirname(nvm)}:/usr/bin:/bin`,
      DEN_SERVICE_STABLE_NODES: stable,
    });
    expect(r.status).toBe(0);
    expect(programNode(r.stdout)).toBe(nvm);
    // print writes the plist only; install is where the warning goes.
    expect(r.stderr).toBe("");
    const src = fs.readFileSync(
      path.join(root, "service", "install.sh"),
      "utf-8",
    );
    expect(src).toMatch(
      /if \[ "\$\{1:-\}" = install \]; then\n\s+echo "⚠ the service will run/,
    );
    fs.rmSync(t, { recursive: true, force: true });
  });

  it("DEN_SERVICE_NODE wins", () => {
    const t = tmp();
    const mine = fakeNode(path.join(t, "mine"), "22");
    const r = print({ DEN_SERVICE_NODE: mine });
    expect(programNode(r.stdout)).toBe(mine);
    fs.rmSync(t, { recursive: true, force: true });
  });

  (process.platform === "darwin" ? it : it.skip)(
    "status names an installed node that no longer exists (exit 1)",
    () => {
      const t = tmp();
      const label = "local.den-test-missing-node.web";
      const agents = path.join(t, "Library", "LaunchAgents");
      fs.mkdirSync(agents, { recursive: true });
      const gone = path.join(
        t,
        ".nvm",
        "versions",
        "node",
        "v18.0.0",
        "bin",
        "node",
      );
      const plist = spawnSync(
        "bash",
        [path.join(root, "service", "install.sh"), "print"],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            DEN_ROOT: path.join(root, "examples", "distribution"),
            DEN_SERVICE_NODE: process.execPath,
          },
        },
      ).stdout.replace(process.execPath, gone);
      fs.writeFileSync(path.join(agents, `${label}.plist`), plist);
      const r = spawnSync(
        "bash",
        [path.join(root, "service", "install.sh"), "status"],
        {
          encoding: "utf-8",
          env: {
            ...process.env,
            HOME: t,
            DEN_ROOT: path.join(root, "examples", "distribution"),
            DEN_SERVICE_LABEL: label,
          },
        },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(
        /runs .*v18\.0\.0\/bin\/node, which no longer exists: re-run service install/,
      );
      fs.rmSync(t, { recursive: true, force: true });
    },
  );
});
