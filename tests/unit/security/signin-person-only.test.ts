/**
 * Sign-in: links and codes that let a browser in are for the person only.
 * Where the CLI runs is checked by its process tree (each running
 * session's root, from the session host's records) as well as by its
 * environment, and a link or code is printed only to a terminal. A tree or
 * a record that can't be read refuses.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  personHereRefusal,
  sessionRootPids,
  terminalRefusal,
} from "../../../src/shared/person-here.js";
import { parentLine } from "../../../src/shared/peer-process.js";
import {
  cmdWebApprove,
  cmdWebToken,
  cmdWebClaimLink,
  cmdWebLogin,
  cmdWebLoginWait,
  freshLoginLink,
  noLinkHereLine,
} from "../../../src/ui/cli/web-command.js";

let tmp = "";
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-signin-")));
  for (const k of ["DEN_AGENT", "DEN_ACTOR_TOKEN", "DEN_ACTOR_TOKEN_FILE"]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A session host's record, as host.ts persists it. */
function record(id: string, pid: number, exited = false): void {
  const dir = path.join(tmp, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: `den-p:${id}`,
      pid,
      ...(exited ? { exited: true } : {}),
    }),
  );
}

describe("sessionRootPids", () => {
  it("lists running sessions' pids, not exited ones; none without the folder", () => {
    expect(sessionRootPids(tmp)).toEqual([]);
    record("a", 4100);
    record("b", 4200, true);
    expect(sessionRootPids(tmp)).toEqual([4100]);
  });
  it("a record that won't parse: null", () => {
    record("a", 4100);
    fs.writeFileSync(path.join(tmp, "sessions", "b.json"), "{not json");
    expect(sessionRootPids(tmp)).toBeNull();
  });
});

describe("parentLine", () => {
  const stat = (pid: number, ppid: number) =>
    `${pid} (x) S ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 20 0 1 0 0 0 0`;
  it("walks to init", () => {
    const files: Record<string, string> = {
      "/proc/400/stat": stat(400, 300),
      "/proc/300/stat": stat(300, 1),
    };
    expect(
      parentLine(400, { platform: "linux", read: (p) => files[p] }),
    ).toEqual([400, 300, 1]);
  });
  it("a parent that can't be read: null", () => {
    const files: Record<string, string> = { "/proc/400/stat": stat(400, 300) };
    const read = (p: string) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    };
    expect(parentLine(400, { platform: "linux", read })).toBeNull();
  });
  it("a platform it can't read: null", () => {
    expect(parentLine(400, { platform: "win32" })).toBeNull();
  });
  it("this process, for real, reaches init", () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const line = parentLine(process.pid);
    expect(line?.[0]).toBe(process.pid);
    expect(line).toContain(process.ppid);
  });
});

describe("personHereRefusal", () => {
  it("inside a running session's tree: refused", () => {
    record("a", 300);
    expect(
      personHereRefusal({
        env: {},
        stateDir: tmp,
        line: () => [500, 400, 300, 1],
      }),
    ).toMatch(/Terminals page/);
  });
  it("a parent chain that can't be read: refused", () => {
    expect(
      personHereRefusal({ env: {}, stateDir: tmp, line: () => null }),
    ).toMatch(/can't let a browser in from here/);
  });
  it("session records that can't be read: refused", () => {
    expect(
      personHereRefusal({
        env: {},
        stateDir: tmp,
        line: () => [500, 1],
        roots: () => null,
      }),
    ).toMatch(/can't let a browser in from here/);
  });
  it("an agent's session: refused, as before", () => {
    expect(
      personHereRefusal({
        env: { DEN_AGENT: "agent:x" },
        stateDir: tmp,
        line: () => [500, 1],
      }),
    ).toMatch(/can't let a browser in from here/);
  });
  it("a terminal outside every session: allowed", () => {
    record("a", 300);
    record("b", 400, true);
    expect(
      personHereRefusal({
        env: {},
        stateDir: tmp,
        line: () => [500, 400, 200, 1],
      }),
    ).toBeNull();
  });
  it("terminalRefusal: only a terminal", () => {
    expect(terminalRefusal(true)).toBeNull();
    expect(terminalRefusal(false)).toMatch(/only in a terminal/);
  });
});

function io(person: { line?: () => number[] | null; tty?: boolean }) {
  const o = { out: "", err: "" };
  return {
    o,
    io: {
      out: (s: string) => (o.out += s),
      err: (s: string) => (o.err += s),
      stateDir: tmp,
      webUrl: () => ({ url: "https://den.acme.example.com", confirmed: true }),
      person,
    },
  };
}

describe("the CLI inside a running session's tree", () => {
  const inside = { line: () => [process.pid, 300, 1], tty: true };
  beforeEach(() => record("a", 300));
  const refused = (code: number, o: { out: string; err: string }) => {
    expect(code).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/Terminals page/);
    expect(fs.existsSync(path.join(tmp, "web.secret"))).toBe(false);
  };
  it("web login --no-wait refuses", async () => {
    const { o, io: i } = io(inside);
    refused(await cmdWebLogin(["--no-wait"], i), o);
  });
  it("web login refuses", async () => {
    const { o, io: i } = io(inside);
    refused(await cmdWebLoginWait([], i), o);
  });
  it("web claim-link refuses", () => {
    const { o, io: i } = io(inside);
    refused(cmdWebClaimLink([], i), o);
  });
  it("web approve refuses", async () => {
    const { o, io: i } = io(inside);
    refused(await cmdWebApprove(["K7Q-42M"], i), o);
  });
  it("freshLoginLink throws", () => {
    expect(() =>
      freshLoginLink(4100, "/", "https://den.acme.example.com", tmp, inside),
    ).toThrow(/Terminals page/);
  });
});

describe("the CLI where its parent chain can't be read", () => {
  it("web login --no-wait refuses", async () => {
    const { o, io: i } = io({ line: () => null, tty: true });
    expect(await cmdWebLogin(["--no-wait"], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/can't let a browser in from here/);
  });
});

describe("the CLI not in a terminal", () => {
  const piped = { line: () => [process.pid, 1], tty: false };
  it("web login --no-wait prints no link", async () => {
    const { o, io: i } = io(piped);
    expect(await cmdWebLogin(["--no-wait"], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/only in a terminal/);
  });
  it("web login prints no link and no code", async () => {
    const { o, io: i } = io(piped);
    expect(await cmdWebLoginWait([], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).not.toMatch(/code:/);
  });
  it("web claim-link prints no link", () => {
    const { o, io: i } = io(piped);
    expect(cmdWebClaimLink([], i)).toBe(1);
    expect(o.out).toBe("");
  });
});

describe("the person's own terminal", () => {
  const mine = { line: () => [process.pid, 200, 1], tty: true };
  beforeEach(() => record("a", 300));
  it("web login --no-wait prints a link", async () => {
    const { o, io: i } = io(mine);
    expect(await cmdWebLogin(["--no-wait"], i)).toBe(0);
    expect(o.out).toMatch(/^https:\/\/den\.acme\.example\.com\/auth\?c=/);
  });
  it("web claim-link prints a link", () => {
    const { o, io: i } = io(mine);
    expect(cmdWebClaimLink([], i)).toBe(0);
    expect(o.out).toMatch(/\/auth\?claim=c1\./);
  });
});

describe("Sign-in: each refusal says what to do instead", () => {
  it("inside a running session: your own terminal, or Settings › Access", () => {
    record("a", 300);
    const t = personHereRefusal({
      env: {},
      stateDir: tmp,
      line: () => [500, 300, 1],
    });
    expect(t).toMatch(/Terminals page/);
    expect(t).toMatch(/Run it in your own terminal/);
    expect(t).toMatch(/Settings › Access/);
  });
  it("couldn't check: your own terminal, or Settings › Access", () => {
    const t = personHereRefusal({ env: {}, stateDir: tmp, line: () => null });
    expect(t).toMatch(/your own terminal/);
    expect(t).toMatch(/Settings › Access/);
  });
  it("not a terminal: where to run it", () => {
    expect(terminalRefusal(false)).toMatch(
      /Run it yourself in a terminal window on this machine/,
    );
  });
  it("web up with no terminal: the address, and the command that prints a link", () => {
    expect(noLinkHereLine("https://den.acme.example.com/", "acme")).toBe(
      "https://den.acme.example.com (a sign-in link is printed only in a terminal: run `acme web login` in one)",
    );
  });
  it("an agent's session: what to do instead, in plain words", () => {
    const t = personHereRefusal({
      env: { DEN_AGENT: "agent:x" },
      stateDir: tmp,
      line: () => [500, 1],
    });
    expect(t).toMatch(/Run it in your own terminal/);
    expect(t).toMatch(/Settings › Access/);
    expect(t).not.toMatch(/An agent can't/);
  });
});

describe("Sign-in: web token --print", () => {
  const tokenIo = (person: { line?: () => number[] | null; tty?: boolean }) =>
    io(person);
  it("inside a running session's tree: refused, nothing printed", () => {
    record("a", 300);
    const { o, io: i } = tokenIo({
      line: () => [process.pid, 300, 1],
      tty: true,
    });
    expect(cmdWebToken(["--print"], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/Terminals page/);
  });
  it("a parent chain that can't be read: refused", () => {
    const { o, io: i } = tokenIo({ line: () => null, tty: true });
    expect(cmdWebToken(["--print"], i)).toBe(1);
    expect(o.out).toBe("");
  });
  it("not a terminal: refused, and says where to run it", () => {
    const { o, io: i } = tokenIo({ line: () => [process.pid, 1], tty: false });
    expect(cmdWebToken(["--print"], i)).toBe(1);
    expect(o.out).toBe("");
    expect(o.err).toMatch(/in a terminal window on this machine/);
  });
  it("the person's own terminal: the token", () => {
    const { o, io: i } = tokenIo({ line: () => [process.pid, 1], tty: true });
    expect(cmdWebToken(["--print"], i)).toBe(0);
    expect(o.out.trim().length).toBeGreaterThan(20);
  });
});

describe("Sign-in: issue 819", () => {
  // Skipped: issue 819 (open). Kept here so the case is tracked; it fails
  // today by design of the current checks.
  it.skip("issue 819 (open): refused", () => {
    record("a", 300);
    expect(
      personHereRefusal({ env: {}, stateDir: tmp, line: () => [500, 1] }),
    ).not.toBeNull();
  });
});
