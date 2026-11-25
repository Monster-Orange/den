import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sharedUserLines } from "../../../src/ui/cli/doctor-command.js";
import { registerInstall } from "../../../src/shared/install-registry.js";

let root = "";
let state = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1521-")));
  state = path.join(root, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  fs.chmodSync(state, 0o700);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const SECRET = "SECRET_VALUE_NEVER_SHOWN";
const put = (rel: string) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, SECRET + "\n", { mode: 0o600 });
  fs.chmodSync(f, 0o600);
};
const run = (unsandboxed: { id: string; projects: string[] }[]) => {
  registerInstall(path.join(root, "installs"), {
    stateDir: state,
    edgeKeyDirs: [],
  });
  return sharedUserLines("Den", {
    stateDir: state,
    registry: path.join(root, "installs"),
    home: root,
    serverRunning: () => false,
    trailReadable: true,
    unsandboxed: () => unsandboxed,
    reposOf: (p) => (p === "north" ? [path.join(root, "shop-api")] : []),
  });
};
const check = (r: ReturnType<typeof run>, id: string) =>
  r.checks.find((c) => c.id === id);

beforeEach(() => {
  put("state/web.secret");
  put("state/actor-token/planner/token");
  put("state/app-feeds/f1/events/1-a-2.json");
  put("state/app-feeds/f1/events/2-b-2.json");
  put("shop-api/.stack-secrets.yml");
});

describe("issue 1521: the 0600 row and the OS sandbox", () => {
  it("every agent sandboxed: a note that the sandbox keeps them out, not a warning", () => {
    const r = run([]);
    const s = check(r, "uncovered_files")!;
    expect(s.status).toBe("ok");
    expect(s.detail).toMatch(/2 0600 files .*no Claude Read rule/);
    expect(s.detail).toMatch(/the OS sandbox keeps every agent out/);
    expect(r.checks.some((c) => c.id.startsWith("agent_unsandboxed"))).toBe(
      false,
    );
  });

  it("an agent with its sandbox off: the row warns, and that agent's own row names what it can read", () => {
    const r = run([
      { id: "planner", projects: ["north"] },
      { id: "scribe", projects: ["south"] },
    ]);
    expect(check(r, "uncovered_files")!.status).toBe("warn");
    const p = check(r, "agent_unsandboxed:planner")!;
    expect(p.status).toBe("warn");
    expect(p.detail).toMatch(/planner runs outside the OS sandbox/);
    expect(p.detail).toMatch(/web\.secret/);
    expect(p.detail).toMatch(/agents' tokens/);
    expect(p.detail).toMatch(/1 project stack secrets file/);
    expect(p.detail).toMatch(/agents\.sandbox/);
    const s = check(r, "agent_unsandboxed:scribe")!;
    expect(s.detail).not.toMatch(/stack secrets/);
    const all = [...r.lines, ...r.checks.map((c) => c.detail)].join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(root);
    expect(r.lines.some((l) => l.includes("planner"))).toBe(true);
  });
});
