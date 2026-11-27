/**
 * Issue 1417: `config agents.<limit>` prints the value in force for every
 * agent limit, exit 0, with the value as stdout's last line (scripts read
 * it) and its source on stderr. Before, seven of the eight errored with
 * the usage line. Invented names only; a temp DEN_ROOT.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

type ConfigCmd = typeof import("../../../src/ui/cli/config-command.js");
type DenCfg = typeof import("../../../src/shared/den-config.js");

let root = "";
const savedRoot = process.env.DEN_ROOT;
let cli: ConfigCmd;
let cfg: DenCfg;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1417c-")));
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\nagents:\n  rotation_wait_minutes: 200\n",
  );
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "agents:\n  lock_wait_minutes: 45\n",
  );
  process.env.DEN_ROOT = root;
  cli = await import("../../../src/ui/cli/config-command.js");
  cfg = await import("../../../src/shared/den-config.js");
});
afterAll(() => {
  if (savedRoot === undefined) delete process.env.DEN_ROOT;
  else process.env.DEN_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function read(key: string): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    await cli.cmdConfig([key]);
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out, err };
}

describe("issue 1417: config reads every agent limit", () => {
  it("an unset limit: its default as the last line, exit 0, the source on stderr", async () => {
    const r = await read("agents.restart_wait_minutes");
    expect(r.out.at(-1)).toBe("120");
    expect(r.err.join("\n")).toMatch(/Den's default/);
  });

  it("set in den.yml only: den.yml's", async () => {
    const r = await read("agents.rotation_wait_minutes");
    expect(r.out.at(-1)).toBe("200");
    expect(r.err.join("\n")).toMatch(/den\.yml/);
  });

  it("set in user.yml: user.yml's", async () => {
    const r = await read("agents.lock_wait_minutes");
    expect(r.out.at(-1)).toBe("45");
    expect(r.err.join("\n")).toMatch(/user\.yml/);
  });

  it("every agent limit reads back", async () => {
    for (const k of cfg.AGENTS_USER_LIMIT_KEYS) {
      const r = await read(`agents.${k}`);
      expect(r.out.at(-1)).toMatch(
        k === "subagents_respect_load_hold"
          ? /^(true|false)$/
          : /^\d+(\.\d+)?$/,
      );
    }
  });

  it("max_concurrent's stdout is unchanged (one line, the value)", async () => {
    const r = await read("agents.max_concurrent");
    expect(r.out).toEqual(["4"]);
  });
});
