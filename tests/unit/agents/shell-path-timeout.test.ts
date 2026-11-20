/**
 * Issue 456 follow-up: how long Den waits for your shell's PATH is a
 * setting, `agents.shell_path_timeout_seconds` in user.yml (10 when unset,
 * 1 to 120), with a Settings row. Both asks use it: the login shell's
 * (`-lc`) and the interactive shell's (`-ilc`), which now comes first on
 * every detection, so a slow .zshrc must still be read.
 *
 * Fake shells in temp dirs only: no test runs this machine's shell.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as config from "../../../src/shared/den-config.js";
import * as cliRows from "../../../src/shared/settings-cli-rows.js";
import * as search from "../../../src/shared/agents/runtime-search.js";
import {
  listRuntimes,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

const tmps: string[] = [];
afterEach(async () => {
  search.resetInteractivePath();
  search.clearVersionCache();
  await cleanupRigs();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sp-")));
  tmps.push(d);
  return d;
}

function write(file: string, content: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}

/** A shell whose startup takes `seconds` (a slow .zshrc), then says PATH. */
function slowShell(root: string, dir: string, seconds: number): string {
  return write(
    path.join(root, "slow-shell"),
    [
      "#!/bin/sh",
      `sleep ${seconds}`,
      `printf '__DEN_PATH_BEGIN__%s__DEN_PATH_END__' "${dir}:/usr/bin"`,
      "",
    ].join("\n"),
  );
}

describe("the shell PATH wait (agents.shell_path_timeout_seconds)", () => {
  it("is a setting: 10 when unset, 1 to 120, a wrong value refused naming the key", () => {
    const read = (v: unknown) => () => ({
      agents: { shell_path_timeout_seconds: v },
    });
    expect(config.agentsShellPathTimeoutSeconds(() => ({}))).toBe(10);
    expect(config.agentsShellPathTimeoutSeconds(read(30))).toBe(30);
    expect(config.agentsShellPathTimeoutSeconds(read(1))).toBe(1);
    expect(config.agentsShellPathTimeoutSeconds(read(120))).toBe(120);
    for (const bad of [0, 121, "10", -1])
      expect(() => config.agentsShellPathTimeoutSeconds(read(bad))).toThrow(
        /agents\.shell_path_timeout_seconds must be a number from 1 to 120/,
      );
  });

  it("a slow .zshrc (4 s) is still read under the default, for -lc and -ilc", async () => {
    const root = tmp();
    const shell = slowShell(root, path.join(root, "rc-bin"), 4);
    const env = { DEN_LOGIN_SHELL: shell };
    const [login, interactive] = await Promise.all([
      search.resolveLoginPath({ env }),
      search.resolveLoginPath({ env, flags: "-ilc" }),
    ]);
    expect(login).toBe(`${path.join(root, "rc-bin")}:/usr/bin`);
    expect(interactive).toBe(`${path.join(root, "rc-bin")}:/usr/bin`);
  }, 20_000);

  it("detection uses the setting: under the default the slow interactive PATH finds codex; at 1 s it gives up", async () => {
    const r = await rig();
    const rcBin = path.join(r.dir, "rc-bin");
    const codex = write(
      path.join(rcBin, "codex"),
      `#!/bin/sh\n[ "$1" = "--version" ] && { echo "codex-cli 0.60.0"; exit 0; }\nexit 1\n`,
    );
    r.deps.env = {
      ...r.deps.env,
      DEN_LOGIN_SHELL: slowShell(r.dir, rcBin, 2),
    };
    // The default (10 s).
    let row = (await listRuntimes(resolveAgentsDeps(r.deps))).find(
      (x) => x.id === "codex",
    )!;
    expect(row).toMatchObject({ path: codex, source: "interactive-shell" });
    // Set to 1 s: the 2-second shell is left out.
    search.resetInteractivePath();
    row = (
      await listRuntimes(
        resolveAgentsDeps({ ...r.deps, shellPathTimeoutSeconds: () => 1 }),
      )
    ).find((x) => x.id === "codex")!;
    expect(row.available).toBe(false);
  }, 20_000);

  it("Settings has its row, and the page's POST field writes user.yml agents.shell_path_timeout_seconds", () => {
    const rowDef = (
      DEN_SETTINGS as {
        id: string;
        keys?: string[];
        control?: Record<string, unknown>;
        scope?: string;
      }[]
    ).find((s) => s.keys?.includes("agents_shell.path_timeout_seconds"));
    expect(rowDef).toMatchObject({
      category: "agents",
      scope: "user",
      control: { type: "number", min: 1, max: 120, unit: "s" },
    });
    const user: Record<string, unknown> = {
      agents: { runtimes: { codex: { bin: "/x/codex" } } },
    };
    expect(
      cliRows.patchCliRows(user, {
        agents_shell: { path_timeout_seconds: 30 },
      }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({
      runtimes: { codex: { bin: "/x/codex" } },
      shell_path_timeout_seconds: 30,
    });
    for (const bad of [0, 121])
      expect(
        cliRows.patchCliRows(user, {
          agents_shell: { path_timeout_seconds: bad },
        }).ok,
      ).toBe(false);
    // null clears it (back to 10); the rest of agents stays.
    cliRows.patchCliRows(user, {
      agents_shell: { path_timeout_seconds: null },
    });
    expect(user.agents).toEqual({ runtimes: { codex: { bin: "/x/codex" } } });
  });
});
