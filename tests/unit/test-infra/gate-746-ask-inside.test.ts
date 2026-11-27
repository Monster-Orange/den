import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Out {
  sh: { id: string; cmd: string }[];
  mcpViaCli: string[][];
  r: { code: number | null; out: string; err: string; project: string };
}

function runAsk(status: number | null = 0): Out {
  const js = `
    const g = await import("./gate/746.mjs");
    const sh = [];
    const mcpViaCli = [];
    const ctx = {
      o: { bed: "/bed root" },
      agent: (id) => ({
        sh: async (cmd) => (sh.push({ id, cmd }), { status: ${JSON.stringify(status)}, out: "said out", err: "said err" }),
      }),
      cli: (args) => (args[0] === "mcp" && mcpViaCli.push(args), { code: 0, out: "", err: "" }),
      listBed: (p) => (p.startsWith("state:actor-token/") ? ["token"] : []),
      readBed: (p) => (p.startsWith("state:agents/") ? JSON.stringify({ workspace: "proj-x" }) : ""),
    };
    const r = await g.ask(ctx, "gate-746-allow-abc");
    console.log(JSON.stringify({ sh, mcpViaCli, r }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop() as string) as Out;
}

describe("issue 746's live check asks from inside each stub", () => {
  it("runs the bed's CLI in the stub's own shell, with its token file, and never from the harness", () => {
    const o = runAsk();
    expect(o.mcpViaCli).toEqual([]);
    expect(o.sh).toHaveLength(1);
    const { id, cmd } = o.sh[0];
    expect(id).toBe("gate-746-allow-abc");
    expect(cmd).not.toMatch(/[\r\n]/);
    expect(cmd).toContain(`'/bed root/bin/den-gate' mcp --workspace 'proj-x'`);
    expect(cmd).toContain(
      `--actor 'agent:gate-746-allow-abc' --call agent_mode`,
    );
    expect(cmd).toMatch(
      /DEN_ACTOR_TOKEN_FILE='[^']*actor-token[/\\]gate-746-allow-abc[/\\]token'/,
    );
    expect(cmd).toContain(`"agent":"gate-746-allow-abc","ask":true`);
    expect(cmd).toContain(`perl -e 'alarm 15; exec @ARGV' '/bed root/`);
    expect(o.r).toEqual({
      project: "proj-x",
      code: 0,
      out: "said out",
      err: "said err",
    });
  });

  it("a /sh that never answers reports no exit code", () => {
    expect(runAsk(null).r.code).toBeNull();
  });
});
