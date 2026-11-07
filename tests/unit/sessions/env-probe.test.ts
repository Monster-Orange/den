/**
 * `<cli> doctor --probe` (AG spec §5a-env): a real session host on a temp
 * socket, a PTY stand-in that really runs the probe (pipes, no native
 * module), and PATH shims for each catalog runtime's CLI (claude, codex,
 * gemini, grok) that must never run. The caller's env
 * carries Claude Code's session plumbing and a token; the probe reports
 * key names and flags only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { SessionHost } from "../../../src/shared/sessions/host.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { PtyLoad } from "../../../src/shared/sessions/pty.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import {
  formatProbe,
  runEnvProbe,
  type ProbeDeps,
} from "../../../src/ui/cli/env-probe.js";
import { plainSessionEnv } from "../../../src/ui/cli/sessions-command.js";
import { pipePtyFactory } from "./helpers/fake-pty.js";

const tmps: string[] = [];
const hosts: SessionHost[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** 0.4.0-dev.2's session env: the caller's, less Den's own plumbing. */
function inheritedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  for (const k of ["DEN_INVOKE_CWD", "DEN_ENGINE_ROOT"]) delete out[k];
  if (!out.TERM) out.TERM = "xterm-256color";
  return out;
}

async function rig(pty?: PtyLoad): Promise<{ deps: ProbeDeps; ran: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-probe-test-"));
  tmps.push(dir);
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const ran = path.join(dir, "claude-ran");
  // Every catalog runtime's CLI, as a shim that must never run.
  for (const b of ["claude", "codex", "gemini", "grok"])
    fs.writeFileSync(
      path.join(bin, b),
      `#!/bin/sh\necho "$@" >> "${ran}"\nexit 1\n`,
      { mode: 0o755 },
    );
  const load: PtyLoad = pty ?? { available: true, factory: pipePtyFactory };
  const h = new SessionHost({
    stateDir: dir,
    pty: () => load,
    flushMs: 0,
    log: () => undefined,
  });
  hosts.push(h);
  await h.listen();
  return {
    ran,
    deps: {
      dist: "acme",
      cli: "acme",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: "/home/someone",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "parent-session",
        FAKE_PROBE_TOKEN: "probe-value-xyz",
      },
      pty: () => load,
      connect: () => connectHost(sessionPaths(dir).socket),
      plainEnv: (caller) => plainSessionEnv(caller),
    },
  };
}

const reached = (results: Awaited<ReturnType<typeof runEnvProbe>>) =>
  results.flatMap((r) => r.findings.map((f) => `${r.target}: ${f.key}`));

describe("doctor --probe", () => {
  it("with the caller's env inherited (as 0.4.0-dev.2 built it), reports every leak, names only", async () => {
    const { deps, ran } = await rig();
    const results = await runEnvProbe({
      ...deps,
      plainEnv: inheritedEnv,
      agentEnv: (caller, _rt, launch) => ({
        ...inheritedEnv(caller),
        ...launch,
      }),
    });
    const found = reached(results);
    for (const target of [
      "plain session",
      "agent (den-claude)",
      "agent (codex)",
      "agent (gemini)",
      "agent (grok)",
      "agent (generic)",
    ])
      for (const key of [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "FAKE_PROBE_TOKEN",
      ])
        expect(found).toContain(`${target}: ${key}`);
    const text = formatProbe(results).join("\n");
    expect(text).toMatch(/✗ CLAUDE_CODE_SESSION_ID reaches it/);
    expect(text).not.toContain("probe-value-xyz");
    expect(text).not.toContain("parent-session");
    // The runtime's CLI never ran: the probe ran in its place.
    expect(fs.existsSync(ran)).toBe(false);
  }, 30_000);

  it("is clean with the env sessions and agents start build", async () => {
    const { deps, ran } = await rig();
    const results = await runEnvProbe(deps);
    expect(results.map((r) => r.target)).toEqual([
      "plain session",
      "agent (den-claude)",
      "agent (codex)",
      "agent (gemini)",
      "agent (grok)",
      "agent (generic)",
    ]);
    expect(reached(results)).toEqual([]);
    for (const r of results) {
      expect(r.ran).toBe(true);
      expect(r.keys).toBeGreaterThan(0);
    }
    expect(formatProbe(results).join("\n")).toMatch(/plain session\s+✓ clean/);
    expect(fs.existsSync(ran)).toBe(false);
    // Its sessions are gone afterwards.
    const c = await deps.connect();
    expect(await c.list()).toEqual([]);
    c.close();
  }, 30_000);

  it("the agent env it checks is the one agents start builds", () => {
    const env = agentSessionEnv(
      {
        PATH: "/usr/bin",
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "x",
        FOO: "y",
      },
      { envPassthrough: [] },
      // Even a launch env cannot put a scrubEnv name back.
      { CLAUDE_CODE_ENTRYPOINT: "z", OWN: "1" },
      "planner",
    );
    expect(Object.keys(env).sort()).toEqual([
      "DEN_AGENT",
      "OWN",
      "PATH",
      "TERM",
    ]);
  });

  it("without the PTY module it says unavailable, not failed", async () => {
    const { deps } = await rig({
      available: false,
      reason: "@lydell/node-pty is not installed",
    });
    const results = await runEnvProbe(deps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ran: false, findings: [] });
    expect(formatProbe(results).join("\n")).toMatch(
      /not probed: den-pty is unavailable/,
    );
  });
});
