/**
 * 0.4.12: an agent never gets a way to sign a browser in as the person.
 * Inside an agent's session (DEN_AGENT or DEN_ACTOR_TOKEN set), every
 * command that mints a person's credential refuses before it touches
 * web.secret: `web login` (both forms), `web approve <code>` (pairs a
 * device), `web owner link|unlink`, and `web claim-link`. Without this an
 * agent runs `web login --no-wait`, opens the link with curl, keeps the
 * cookie, and approves its own change.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  cmdWebApprove,
  cmdWebClaimLink,
  cmdWebLogin,
  cmdWebLoginWait,
  cmdWebOwner,
  freshLoginLink,
} from "../../../src/ui/cli/web-command.js";

let tmp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wagent-")));
  for (const k of ["DEN_AGENT", "DEN_ACTOR_TOKEN"]) saved[k] = process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function io() {
  const o = { out: "", err: "" };
  return {
    o,
    io: {
      out: (s: string) => (o.out += s),
      err: (s: string) => (o.err += s),
      stateDir: tmp,
    },
  };
}

const AGENT_ENVS: [string, string][] = [
  ["DEN_AGENT", "agent:planner"],
  ["DEN_ACTOR_TOKEN", "den_at_x"],
];

describe.each(AGENT_ENVS)("inside an agent's session (%s set)", (k, v) => {
  beforeEach(() => {
    process.env[k] = v;
  });

  const expectRefused = (code: number, o: { out: string; err: string }) => {
    expect(code).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/An agent can't do this/);
    // Nothing touched web.secret: no file was made.
    expect(fs.existsSync(path.join(tmp, "web.secret"))).toBe(false);
  };

  it("web login --no-wait refuses", () => {
    const { o, io: i } = io();
    expectRefused(cmdWebLogin(["--no-wait"], i), o);
  });

  it("web login (waits) refuses", async () => {
    const { o, io: i } = io();
    expectRefused(await cmdWebLoginWait([], i), o);
  });

  it("web approve <code> refuses (pairing lets a browser in)", async () => {
    const { o, io: i } = io();
    expectRefused(await cmdWebApprove(["K7Q-42M"], i), o);
  });

  it.each([["link"], ["unlink"]])("web owner %s refuses", async (sub) => {
    const { o, io: i } = io();
    expectRefused(await cmdWebOwner([sub], i), o);
  });

  it("web claim-link refuses", () => {
    const { o, io: i } = io();
    expectRefused(cmdWebClaimLink([], i), o);
  });

  it("freshLoginLink (what `web open` hands the browser) throws", () => {
    expect(() => freshLoginLink(4100, "/", undefined, tmp)).toThrow(
      /An agent can't do this/,
    );
  });
});

describe("in the person's own terminal", () => {
  beforeEach(() => {
    delete process.env.DEN_AGENT;
    delete process.env.DEN_ACTOR_TOKEN;
  });
  it("web login --no-wait prints a link", () => {
    const { o, io: i } = io();
    expect(cmdWebLogin(["--no-wait"], i)).toBe(0);
    expect(o.out).toMatch(/^http:\/\/localhost:\d+\/auth\?c=/);
  });
  it("web claim-link prints one link to the page with ?claim=", () => {
    const { o, io: i } = io();
    expect(cmdWebClaimLink(["--port", "4100"], i)).toBe(0);
    expect(o.out.trim().split("\n")).toHaveLength(1);
    expect(o.out).toMatch(/^http:\/\/localhost:4100\/auth\?claim=c1\./);
  });
});
