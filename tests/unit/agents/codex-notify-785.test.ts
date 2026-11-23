/**
 * Issue 785: Codex reports its conversation through its own `notify`
 * setting, which Den sets for that launch only (`-c notify=[…]`): the
 * program it runs is Den's own CLI (`agents report-resume --notify-json`),
 * never anything from config or from the agent. The catalog's "{report}"
 * stands for that program, as a TOML array of separate words (Codex runs
 * it directly, never through a shell).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  BUILTIN_CATALOG,
  validateCatalog,
} from "../../../src/shared/agents/catalog.js";
import { catalogRuntime } from "../../../src/shared/agents/catalog-runtime.js";
import type { LaunchInput } from "../../../src/shared/agents/runtime.js";
import {
  listRuntimes,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { runtimeRowHtml } from "../../../src/ui/server/public/settings-registry.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

const BIN = "/opt/tools/bin/codex";
const codex = () => BUILTIN_CATALOG.find((e) => e.id === "codex")!;
const input = (o: Partial<LaunchInput> = {}): LaunchInput =>
  ({
    persona: { id: "planner" },
    workspace: { name: "north", dir: "/work/north" },
    agentId: "planner",
    worktree: "/work/north",
    mcp: { name: "acme", command: ["/x/acme", "mcp"], env: {}, scope: "north" },
    filesDir: "/state/files/planner",
    stateDir: "/state",
    env: {},
    bin: BIN,
    denCli: ["/dist/bin/acme"],
    ...o,
  }) as LaunchInput;

/** The program in a `notify=[…]` word, read back. */
const program = (word: string) => {
  expect(word.startsWith("notify=")).toBe(true);
  return JSON.parse(word.slice("notify=".length)) as string[];
};

describe("issue 785: Codex's notify is Den's own CLI, for that launch only", () => {
  it("the catalog: launch and resume both set it", () => {
    expect(codex().launch.argv).toEqual(["{bin}", "-c", "notify={report}"]);
    expect(codex().resume).toEqual({
      argv: ["{bin}", "-c", "notify={report}", "resume", "{conversation}"],
    });
  });

  it("a launch runs Codex with notify set to Den's report command", () => {
    const out = catalogRuntime(codex()).launch(input());
    expect(out.argv.slice(0, 2)).toEqual([BIN, "-c"]);
    expect(program(out.argv[2]!)).toEqual([
      "/dist/bin/acme",
      "agents",
      "report-resume",
      "--notify-json",
    ]);
    expect(out.argv).toHaveLength(3);
  });

  it("a resume keeps it, then resumes the reported thread", () => {
    const out = catalogRuntime(codex()).resume!(
      input({
        resumeReport: { conversation: "019a-77", cwd: "/work/north", seq: 1 },
      }),
    );
    expect(out!.argv[0]).toBe(BIN);
    expect(out!.argv[1]).toBe("-c");
    expect(program(out!.argv[2]!)[2]).toBe("report-resume");
    expect(out!.argv.slice(3)).toEqual(["resume", "019a-77"]);
  });

  it("a CLI path with quotes, backslashes or control characters stays one word each", () => {
    const odd = ['/d i r/"q"\\b\x7f\u0001/acme', "--flag=a,b]"];
    const out = catalogRuntime(codex()).launch(input({ denCli: odd }));
    expect(program(out.argv[2]!)).toEqual([
      ...odd,
      "agents",
      "report-resume",
      "--notify-json",
    ]);
    // No raw control character reaches Codex's TOML.
    expect(
      [...out.argv[2]!].some((c) => c.charCodeAt(0) < 0x20 || c === "\x7f"),
    ).toBe(false);
  });

  it("without Den's CLI it can't launch: says so", () => {
    expect(() =>
      catalogRuntime(codex()).launch(input({ denCli: undefined })),
    ).toThrow(/Den's own command/);
  });

  it("an added entry: {report} once per command, only for a reported conversation", () => {
    const entry = (launch: string[], resume: unknown) => ({
      id: "acme-cli",
      vendor: "Acme",
      name: "Acme CLI",
      bins: ["acme"],
      version: { args: ["--version"], identity: { output: "acme" } },
      dirs: [],
      launch: { argv: launch },
      ...(resume ? { resume } : {}),
    });
    const ok = validateCatalog(
      [
        entry(["{bin}", "-c", "notify={report}"], {
          argv: ["{bin}", "-c", "notify={report}", "resume", "{conversation}"],
        }),
      ],
      "t",
    );
    expect(ok[0]?.launch.argv).toEqual(["{bin}", "-c", "notify={report}"]);
    for (const [launch, resume] of [
      [["{bin}", "-c", "notify={report}"], undefined],
      [
        ["{bin}", "{report}", "{report}"],
        { argv: ["{bin}", "{report}", "{report}", "{conversation}"] },
      ],
      [
        ["{bin}", "-c", "notify={report}"],
        {
          argv: [
            "{bin}",
            "-c",
            "notify={report}",
            "--resume",
            "{conversation}",
          ],
          conversation: "den",
          start: ["--session-id", "{conversation}"],
        },
      ],
      [
        ["{bin}"],
        {
          argv: ["{bin}", "--resume", "{conversation}"],
          conversation: "den",
          start: ["--session-id", "{conversation}", "{report}"],
        },
      ],
    ] as const)
      expect(() => validateCatalog([entry([...launch], resume)], "t")).toThrow(
        /\{report\}/,
      );
  });
});

describe("issue 785: Settings says Den's notify replaces the person's own", () => {
  afterEach(cleanupRigs);

  it("the runtimes list marks the one whose notify Den sets (Codex only)", async () => {
    const r = await rig();
    const rows = await listRuntimes(resolveAgentsDeps(r.deps));
    const of = (id: string) => rows.find((x) => x.id === id);
    expect(of("codex")?.setsNotify).toBe(true);
    for (const id of ["den-claude", "gemini", "grok", "generic"])
      expect(of(id)?.setsNotify).toBeUndefined();
  });

  it("its row says so; another runtime's doesn't", () => {
    const h = runtimeRowHtml(
      { id: "codex", label: "Codex CLI", available: true, setsNotify: true },
      "",
    );
    expect(h).toContain('data-sets-notify="true"');
    expect(h).toContain(
      "Den sets Codex CLI&#39;s notify for the agents it starts, in place of one in your own config, for those agents only.",
    );
    expect(
      runtimeRowHtml(
        { id: "gemini", label: "Gemini CLI", available: true },
        "",
      ),
    ).not.toContain("data-sets-notify");
  });
});
