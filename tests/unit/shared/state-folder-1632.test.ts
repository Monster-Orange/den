import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  claimStateDir,
  giveOwnStateDir,
  ownStateDirOf,
  stateDirShared,
  takeConnectNext,
  writeConnectNext,
} from "../../../src/shared/state-folder.js";
import { HubConnect } from "../../../src/ui/server/hub-connect.js";
import { sharedUserLines } from "../../../src/ui/cli/doctor-command.js";
import { bindHub, readHubBinding } from "../../../src/shared/hub-binding.js";
import {
  checkStateFolderOwn,
  runStateFolderOwn,
} from "../../../src/ui/server/state-folder-held.js";

let root = "";
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-sf-")));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const checkout = (name: string) => {
  const d = path.join(root, name);
  fs.mkdirSync(path.join(d, "config", "local"), { recursive: true });
  return d;
};
const stateDir = () => {
  const d = path.join(root, "state");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};

describe("issue 1632 part 4: which checkout owns a state folder", () => {
  it("the first checkout to start claims it; it isn't shared", () => {
    const a = checkout("a");
    const s = stateDir();
    expect(claimStateDir(s, a)).toEqual({ shared: false });
    expect(stateDirShared(s, a)).toBe(false);
  });

  it("a second checkout that still exists finds it shared, and the claim stays the first's", () => {
    const a = checkout("a");
    const b = checkout("b");
    const s = stateDir();
    claimStateDir(s, a);
    expect(claimStateDir(s, b)).toEqual({ shared: true });
    expect(stateDirShared(s, b)).toBe(true);
    expect(stateDirShared(s, a)).toBe(false);
  });

  it("a claim by a checkout that's gone (moved, deleted) is taken over", () => {
    const a = checkout("a");
    const b = checkout("b");
    const s = stateDir();
    claimStateDir(s, a);
    fs.rmSync(a, { recursive: true, force: true });
    expect(claimStateDir(s, b)).toEqual({ shared: false });
    expect(stateDirShared(s, b)).toBe(false);
  });

  it("an unreadable claim is taken over, never thrown", () => {
    const b = checkout("b");
    const s = stateDir();
    fs.writeFileSync(path.join(s, "owner.json"), "{not json");
    expect(claimStateDir(s, b)).toEqual({ shared: false });
  });
});

describe("issue 1632 part 4: a checkout's own state folder", () => {
  it("none is recorded until one is given", () => {
    expect(ownStateDirOf(checkout("b"))).toBeNull();
  });

  it("giving one makes a new 0700 folder beside the shared one, records it in config/local, and copies nothing", () => {
    const a = checkout("a");
    const b = checkout("b");
    const s = stateDir();
    fs.writeFileSync(path.join(s, "web.secret"), "x", { mode: 0o600 });
    claimStateDir(s, a);
    const dir = giveOwnStateDir(b, s);
    expect(path.dirname(dir)).toBe(path.dirname(s));
    expect(dir).not.toBe(s);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual(["owner.json"]);
    expect(ownStateDirOf(b)).toBe(dir);
    expect(stateDirShared(dir, b)).toBe(false);
    expect(stateDirShared(s, a)).toBe(false);
    expect(fs.readFileSync(path.join(s, "web.secret"), "utf-8")).toBe("x");
  });

  it("the same checkout gets the same folder again", () => {
    const b = checkout("b");
    const s = stateDir();
    expect(giveOwnStateDir(b, s)).toBe(giveOwnStateDir(b, s));
  });

  it("a recorded folder that isn't absolute is ignored", () => {
    const b = checkout("b");
    fs.writeFileSync(
      path.join(b, "config", "local", "state-dir.json"),
      JSON.stringify({ dir: "relative/x" }),
    );
    expect(ownStateDirOf(b)).toBeNull();
  });
});

describe("issue 1632 part 4: Connect on a shared state folder", () => {
  const ORIGIN = "http://localhost:7300";
  const BOUND = "https://bound-hub.example.test";
  const OTHER = "https://other-hub.example.test";
  const hc = (shared: boolean, bound: string | null) =>
    new HubConnect({
      now: () => 1,
      config: () => null,
      exchange: async () => ({ token: "hubi_TESTONLY_sf" }),
      revoke: async () => true,
      store: async () => ({ kind: "file", source: "file:/s/t", where: "/s/t" }),
      forget: async () => undefined,
      readToken: async () => null,
      readUser: () => ({}),
      writeUser: () => undefined,
      installLabel: () => "den on box",
      stateShared: () => ({ shared, boundOrigin: bound }),
    });

  it("refuses another Hub than the one the folder is bound to, with a code the page offers the fix for", () => {
    const r = hc(true, BOUND).start(ORIGIN, OTHER);
    expect(r).toEqual({
      ok: false,
      code: "state_folder_shared",
      hub: OTHER,
      error: expect.stringMatching(/its own state folder/),
    });
  });

  it("the bound Hub itself, an unbound folder, or an unshared one: Connect goes on", () => {
    expect(hc(true, BOUND).start(ORIGIN, `${BOUND}/`).ok).toBe(true);
    expect(hc(true, null).start(ORIGIN, OTHER).ok).toBe(true);
    expect(hc(false, BOUND).start(ORIGIN, OTHER).ok).toBe(true);
  });
});

describe("issue 1632 part 4: doctor on a shared state folder", () => {
  const rows = (stateDir: string, distRoot: string) =>
    sharedUserLines("Den", {
      stateDir,
      distRoot,
      registry: path.join(root, "installs"),
      home: root,
      serverRunning: () => false,
      trailReadable: true,
      unsandboxed: () => [],
      reposOf: () => [],
    }).checks.find((c) => c.id === "state_folder")!;

  it("warns on the second checkout, never naming the first's folder", () => {
    const a = checkout("first-checkout");
    const b = checkout("b");
    const s = stateDir();
    claimStateDir(s, a);
    const r = rows(s, b);
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/another copy/i);
    expect(r.detail).not.toContain("first-checkout");
  });

  it("is ok on the owner, and on a folder of its own", () => {
    const a = checkout("a");
    const s = stateDir();
    claimStateDir(s, a);
    expect(rows(s, a).status).toBe("ok");
  });
});

describe("issue 1632 part 4: Connect carries on in the new folder", () => {
  it("the Hub to connect to is read once, then gone", () => {
    const d = stateDir();
    writeConnectNext(d, "https://other-hub.example.test");
    expect(takeConnectNext(d)).toBe("https://other-hub.example.test");
    expect(takeConnectNext(d)).toBeNull();
  });

  it("none kept, or one that isn't an https address: nothing", () => {
    const d = stateDir();
    expect(takeConnectNext(d)).toBeNull();
    writeConnectNext(d, "javascript:alert(1)");
    expect(takeConnectNext(d)).toBeNull();
  });
});

describe("issue 1632 part 4: two checkouts on two Hubs, after the Allow", () => {
  const HUB_A = "https://hub-a.example.test";
  const HUB_B = "https://hub-b.example.test";
  const bind = (stateDir: string, url: string) =>
    bindHub(
      {
        stateDir,
        readWorkspaces: () => ({ workspaces: {} }) as never,
        writeWorkspaces: () => undefined,
      },
      { url },
    );
  const files = (d: string): string[] =>
    fs
      .readdirSync(d, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(d, path.join(e.parentPath, e.name)))
      .sort();

  it("each ends with its own bound.json, and the first's state is untouched", async () => {
    const a = checkout("a");
    const b = checkout("b");
    const s = stateDir();
    claimStateDir(s, a);
    bind(s, HUB_A);
    fs.writeFileSync(path.join(s, "web.secret"), "kept", { mode: 0o600 });
    const before = files(s).map((f) => [
      f,
      fs.readFileSync(path.join(s, f), "utf-8"),
    ]);
    let restarted = "";
    const d = {
      shared: () => stateDirShared(s, b),
      give: () => giveOwnStateDir(b, s),
      carryOn: (dir: string, hub: string) => writeConnectNext(dir, hub),
      restart: async (why: string) => {
        restarted = why;
        return { ok: true };
      },
    };
    const c = checkStateFolderOwn(d, { hub: HUB_B });
    if (!c.ok) throw new Error(c.error);
    await runStateFolderOwn(d, c.args);
    expect(restarted).not.toBe("");
    const own = ownStateDirOf(b)!;
    expect(own).not.toBe(s);
    expect(takeConnectNext(own)).toBe(HUB_B);
    bind(own, HUB_B);
    expect(readHubBinding(s)?.origin).toBe(HUB_A);
    expect(readHubBinding(own)?.origin).toBe(HUB_B);
    expect(
      files(s).map((f) => [f, fs.readFileSync(path.join(s, f), "utf-8")]),
    ).toEqual(before);
    expect(stateDirShared(own, b)).toBe(false);
    expect(
      checkStateFolderOwn({ ...d, shared: () => stateDirShared(own, b) }, {})
        .ok,
    ).toBe(false);
  });
});
