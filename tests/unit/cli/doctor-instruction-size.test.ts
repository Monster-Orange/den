/**
 * Issue 278 clause 2 in doctor: each running agent's instruction files
 * (stat only) against a share of its model's context; over it, a
 * warning naming the largest file relative to the agent's folder, and its
 * size. A warning, never a failure. Temp dirs, invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { instructionSizeLines } from "../../../src/ui/cli/doctor-command.js";
import { CONTEXT_WATCH_DEFAULTS } from "../../../src/shared/agents/context-watch.js";
import type { AgentRecord } from "../../../src/shared/agents/records.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const home = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-docins-")),
  );
  dirs.push(home);
  const repo = path.join(home, "work", "north");
  const cwd = path.join(repo, "app");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(repo, "CLAUDE.md"), "z".repeat(840 * 1024));
  const rec = (id: string, extra: Partial<AgentRecord> = {}) =>
    ({
      id,
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      cwd,
      session: { backend: "den-pty", id: `s-${id}` },
      sessionName: `acme-north:${id}`,
      startedAt: "2026-11-01T09:59:00.000Z",
      ...extra,
    }) as AgentRecord;
  return { home, cwd, rec };
}

describe("issue 278 clause 2: doctor's instruction-size check", () => {
  it("warns for a running agent, naming the file and its size", () => {
    const { home, rec } = setup();
    const r = instructionSizeLines("Acme", {
      records: () => [
        rec("scout"),
        rec("gone", { stoppedAt: "2026-11-01T10:00:00Z" }),
      ],
      settings: () => ({ ...CONTEXT_WATCH_DEFAULTS }),
      env: { HOME: home },
    });
    expect(r.lines.join("\n")).toContain(
      `north/scout: instruction files are 840 KB`,
    );
    expect(r.lines.join("\n")).toContain(
      `${path.join("..", "CLAUDE.md")} (840 KB)`,
    );
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]).toMatchObject({
      id: "agents:instructions:north/scout",
      status: "warn",
    });
  });

  // Issue 291 item 3.
  it("the user's own ~/.claude/CLAUDE.md is named from home, with CLAUDE_CONFIG_DIR set elsewhere", () => {
    const { home, cwd, rec } = setup();
    fs.rmSync(path.join(home, "work", "north", "CLAUDE.md"));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(
      path.join(home, ".claude", "CLAUDE.md"),
      "z".repeat(840 * 1024),
    );
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "den-docins-cfg-"));
    dirs.push(cfg);
    const r = instructionSizeLines("Acme", {
      records: () => [rec("scout")],
      settings: () => ({ ...CONTEXT_WATCH_DEFAULTS }),
      env: { HOME: home, CLAUDE_CONFIG_DIR: cfg },
    });
    expect(cwd.startsWith(home)).toBe(true);
    const said = r.lines.join("\n");
    expect(said).toContain(
      `${path.join("~", ".claude", "CLAUDE.md")} (840 KB)`,
    );
    expect(said).not.toContain(`..${path.sep}`);
    expect(r.checks[0]?.fix).toContain(path.join("~", ".claude", "CLAUDE.md"));
  });

  it("within the share: ok, and no lines", () => {
    const { home, rec } = setup();
    const r = instructionSizeLines("Acme", {
      records: () => [rec("scout")],
      settings: () => ({
        ...CONTEXT_WATCH_DEFAULTS,
        contextTokens: 10_000_000,
      }),
      env: { HOME: home },
    });
    expect(r.lines).toEqual([]);
    expect(r.checks[0]?.status).toBe("ok");
  });
});
