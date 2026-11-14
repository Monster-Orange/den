/**
 * MODE-5: every `<cli> config <key>=` that Settings tells a person to run
 * names a key `config` accepts (0.4.46: the terminals' reconnect row said
 * `config panes.reconnect_max_failures=20`, which `config` refused). Read
 * from the Settings rows and the shell's English strings (es and ja
 * translate the words, not the command).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { configKeyNames } from "../../../src/ui/cli/config-command.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

function commandKeys(): { file: string; key: string }[] {
  const out: { file: string; key: string }[] = [];
  for (const f of ["settings-registry.js", "shell.js"]) {
    const src = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
    for (const m of src.matchAll(
      /(?:__DEN_CLI__|\{cli\}|\bden) config (?!rm\b)([A-Za-z0-9_.-]+)=/g,
    ))
      out.push({ file: f, key: m[1]! });
  }
  return out;
}

describe("MODE-5: the config keys Settings names", () => {
  it("finds the commands Settings gives", () => {
    const keys = commandKeys().map((k) => k.key);
    expect(keys).toEqual(
      expect.arrayContaining(["local_dev", "log_window_lines"]),
    );
  });

  it("each one is a key `config` accepts", () => {
    const known = new Set(configKeyNames());
    expect(commandKeys().filter((k) => !known.has(k.key))).toEqual([]);
  });
});

describe("MODE-5: `config` sets the limits Settings names, with the page's checks", () => {
  it("sets, refuses out of range, and removes a dotted limit", () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "den-config-keys-")),
    );
    try {
      fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
      fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
      fs.writeFileSync(
        path.join(root, "config", "den.yml"),
        "environments: [local]\n",
      );
      const cli = (arg: string) =>
        spawnSync(
          path.join(process.cwd(), "node_modules", ".bin", "tsx"),
          [
            path.join(process.cwd(), "src", "ui", "cli", "index.ts"),
            "config",
            ...arg.split(" "),
          ],
          {
            cwd: root,
            encoding: "utf-8",
            env: {
              ...process.env,
              DEN_ROOT: root,
              DEN_HOME: path.join(root, "home"),
              HOME: path.join(root, "home"),
              TSX_DISABLE_CACHE: "1",
              NO_COLOR: "1",
            },
          },
        );
      const user = () =>
        (parseYaml(
          fs.readFileSync(
            path.join(root, "config", "local", "user.yml"),
            "utf-8",
          ),
        ) ?? {}) as Record<string, Record<string, unknown>>;
      expect(cli("panes.reconnect_max_failures=20").status).toBe(0);
      expect(cli("web.crash_loop_restarts=8").status).toBe(0);
      expect(user().panes).toEqual({ reconnect_max_failures: 20 });
      expect(user().web).toEqual({ crash_loop_restarts: 8 });
      const bad = cli("panes.reconnect_max_failures=0");
      expect(bad.status).not.toBe(0);
      expect(bad.stderr + bad.stdout).toMatch(/whole number from 1/);
      expect(user().panes).toEqual({ reconnect_max_failures: 20 });
      expect(cli("rm panes.reconnect_max_failures").status).toBe(0);
      expect(user().panes).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
