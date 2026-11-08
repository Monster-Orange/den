/**
 * `doctor --json`'s onboarding checks (ON-2): Node 22.13+, git, Docker only
 * when a registered repo needs it, the web server and its URL, and Den's
 * MCP through it. Each is ok, warn or fail, with a fix the agent can run or
 * a question for the person. Every probe is injected: nothing here asks
 * this machine's Docker, Node, PATH or web server.
 */
import { describe, expect, it } from "@jest/globals";
import {
  nodeOk,
  onboardingChecks,
  type OnboardCheck,
  type OnboardDeps,
} from "../../../src/ui/cli/doctor-onboard.js";
import {
  approvalsLines,
  doctorJson,
  strategyCheck,
  type DoctorRow,
} from "../../../src/ui/cli/doctor-command.js";

function deps(over: Partial<OnboardDeps> = {}): OnboardDeps {
  return {
    nodeVersion: "22.14.0",
    platform: "linux",
    which: (b) => b === "git" || b === "docker",
    dockerRepos: () => [],
    dockerUp: () => true,
    webUrl: "http://localhost:47001",
    probeWeb: async () => ({ kind: "up", version: "9.9.9" }),
    mcpCall: () => ({ ok: true }),
    approvals: () => true,
    bin: "./bin/acme",
    ...over,
  };
}

async function check(id: string, over: Partial<OnboardDeps> = {}) {
  const all = await onboardingChecks(deps(over));
  return all.find((c) => c.id === id) as OnboardCheck;
}

describe("mcp:approvals", () => {
  it("says the held writes are on by default, gated by the person's Allow", async () => {
    const c = await check("mcp:approvals");
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/held writes on/);
  });

  it("says when mcp.approvals: false turned them off", async () => {
    const c = await check("mcp:approvals", { approvals: () => false });
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/held writes off \(mcp\.approvals: false\)/);
  });

  it("a bad mcp.approvals is a fail with the reason", async () => {
    const c = await check("mcp:approvals", {
      approvals: () => {
        throw new Error('mcp.approvals: true or false, not "no"');
      },
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/true or false/);
  });
});

describe("node", () => {
  it.each([
    ["22.13.0", true],
    ["v22.14.1", true],
    ["24.0.0", true],
    ["22.12.9", false],
    ["20.18.0", false],
    ["junk", false],
  ])("%s → %s", (v, ok) => expect(nodeOk(v)).toBe(ok));

  it("an old Node fails, with an install fix and a question", async () => {
    const c = await check("node", { nodeVersion: "20.11.0" });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/20\.11\.0 is older than 22\.13/);
    expect(c.fix).toMatch(/nvm install 22/);
    expect(c.ask).toBeTruthy();
    expect((await check("node")).status).toBe("ok");
  });
});

describe("git", () => {
  it("missing fails and asks; on macOS the fix is xcode-select", async () => {
    const linux = await check("git", { which: () => false });
    expect(linux.status).toBe("fail");
    expect(linux.ask).toMatch(/git/);
    expect(linux.fix).toBeUndefined();
    const mac = await check("git", { which: () => false, platform: "darwin" });
    expect(mac.fix).toBe("xcode-select --install");
    expect((await check("git")).status).toBe("ok");
  });
});

describe("docker: only when a registered repo needs it", () => {
  it("no repo needs it: ok, and Docker is never asked", async () => {
    let asked = false;
    const c = await check("docker", {
      which: (b) => b === "git",
      dockerUp: () => {
        asked = true;
        return false;
      },
    });
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/no registered repo needs Docker/);
    expect(asked).toBe(false);
  });

  it("needed and not installed: fail, naming the repo, with a question", async () => {
    const c = await check("docker", {
      dockerRepos: () => ["shop"],
      which: (b) => b === "git",
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/shop needs Docker, and docker is not on PATH/);
    expect(c.ask).toMatch(/Docker/);
  });

  it("needed, installed, not running: fail; on macOS the fix opens it", async () => {
    const c = await check("docker", {
      dockerRepos: () => ["shop", "api"],
      dockerUp: () => false,
      platform: "darwin",
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/shop, api need Docker, and the Docker daemon/);
    expect(c.fix).toBe("open -a Docker");
  });

  it("needed and running: ok", async () => {
    const c = await check("docker", { dockerRepos: () => ["shop"] });
    expect(c).toMatchObject({ status: "ok" });
    expect(c.detail).toMatch(/needed by shop/);
  });
});

describe("web and mcp", () => {
  it("up: both ok, the web check carries its URL and port", async () => {
    const all = await onboardingChecks(deps());
    expect(all.find((c) => c.id === "web")).toMatchObject({
      status: "ok",
      url: "http://localhost:47001",
      port: 47001,
    });
    expect(all.find((c) => c.id === "mcp")).toMatchObject({ status: "ok" });
  });

  it("down: web fails with `web up` as the fix; mcp fails and is never called", async () => {
    let called = false;
    const all = await onboardingChecks(
      deps({
        probeWeb: async () => ({ kind: "down" }),
        mcpCall: () => {
          called = true;
          return { ok: true };
        },
      }),
    );
    expect(all.find((c) => c.id === "web")).toMatchObject({
      status: "fail",
      fix: "./bin/acme web up --no-open --json",
      url: "http://localhost:47001",
      port: 47001,
    });
    expect(all.find((c) => c.id === "mcp")).toMatchObject({
      status: "fail",
      fix: "./bin/acme web up --no-open --json",
    });
    expect(called).toBe(false);
  });

  it("slow: web fails with a restart as the fix", async () => {
    const c = await check("web", {
      probeWeb: async () => ({ kind: "timeout" }),
    });
    expect(c).toMatchObject({
      status: "fail",
      fix: "./bin/acme web restart --no-open --json",
    });
  });

  it("another distribution's server: fail with a question, never a fix that points at it", async () => {
    const c = await check("web", {
      probeWeb: async () => ({ kind: "foreign", who: "other (Den 1.0.0)" }),
    });
    expect(c.status).toBe("fail");
    expect(c.detail).toMatch(/other \(Den 1\.0\.0\) answers at/);
    expect(c.ask).toMatch(/port/);
  });

  it("the MCP one-shot failing: mcp fails with its reason and a restart fix", async () => {
    const c = await check("mcp", {
      mcpCall: () => ({ ok: false, detail: "fetch failed" }),
    });
    expect(c).toMatchObject({
      status: "fail",
      fix: "./bin/acme web restart --no-open --json",
    });
    expect(c.detail).toMatch(/fetch failed/);
  });
});

describe("approvalsLines (the human doctor)", () => {
  it("says on or off; a bad value is a problem", () => {
    expect(approvalsLines(() => true).lines.join("")).toMatch(/held writes on/);
    expect(approvalsLines(() => false).lines.join("")).toMatch(
      /held writes off/,
    );
    const bad = approvalsLines(() => {
      throw new Error("mcp.approvals: true or false, not 1");
    });
    expect(bad.problem).toBe(true);
    expect(bad.lines.join("")).toMatch(/true or false/);
  });
});

describe("doctorJson", () => {
  const row = (over: Partial<DoctorRow>): DoctorRow => ({
    kind: "secrets",
    selected: "none",
    implicit: false,
    available: true,
    problem: false,
    warnings: [],
    ...over,
  });

  it("a strategy problem is a fail; unavailable but unused is a warn", () => {
    expect(strategyCheck(row({})).status).toBe("ok");
    expect(strategyCheck(row({ available: false })).status).toBe("warn");
    expect(strategyCheck(row({ warnings: ["w"] })).status).toBe("warn");
    expect(
      strategyCheck(row({ available: false, problem: true })),
    ).toMatchObject({ id: "strategy:secrets", status: "fail" });
  });

  it("ok only when nothing fails; onboarding checks come first", async () => {
    const good = await doctorJson(deps(), [row({})]);
    expect(good.ok).toBe(true);
    expect(good.checks.map((c) => c.id)).toEqual([
      "node",
      "git",
      "docker",
      "web",
      "mcp",
      "mcp:approvals",
      "strategy:secrets",
    ]);
    const warnOnly = await doctorJson(deps(), [row({ available: false })]);
    expect(warnOnly.ok).toBe(true);
    const bad = await doctorJson(deps({ nodeVersion: "18.0.0" }), [row({})]);
    expect(bad.ok).toBe(false);
  });
});
