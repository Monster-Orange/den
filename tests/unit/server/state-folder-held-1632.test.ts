import { describe, expect, it } from "@jest/globals";
import {
  checkStateFolderOwn,
  runStateFolderOwn,
  type StateFolderOwnDeps,
} from "../../../src/ui/server/state-folder-held.js";

const HUB = "https://other-hub.example.test";

function rig(shared = true) {
  const did: string[] = [];
  const d: StateFolderOwnDeps = {
    shared: () => shared,
    give: () => {
      did.push("give");
      return "/s/state-abc123";
    },
    carryOn: (dir, hub) => void did.push(`carry ${dir} ${hub}`),
    restart: async (reason) => {
      did.push(`restart ${reason}`);
      return { ok: true, restarting: true };
    },
  };
  return { d, did };
}

describe("issue 1632 part 4: the held write state_folder_own", () => {
  it("only the person's own Allow runs it, and the Allow says what stays behind", () => {
    const c = checkStateFolderOwn(rig().d, { hub: HUB });
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
    expect(c.args).toEqual({ hub: HUB });
    expect(c.detailKeys?.map((k) => k?.key)).toEqual([
      "ap.sf.new",
      "ap.sf.empty",
      "ap.sf.other",
      "ap.sf.restart",
    ]);
    expect(c.details.join(" ")).toMatch(/Nothing is copied or moved/);
  });

  it("with no Hub to carry on to, it only restarts on the new folder", () => {
    const c = checkStateFolderOwn(rig().d, {});
    if (!c.ok) throw new Error(c.error);
    expect(c.args).toEqual({});
    expect(c.detailKeys?.at(-1)?.key).toBe("ap.sf.restartNone");
  });

  it("is refused when this install's folder is already its own, or the Hub address is bad", () => {
    expect(checkStateFolderOwn(rig(false).d, {}).ok).toBe(false);
    expect(checkStateFolderOwn(rig().d, { hub: "ftp://x" }).ok).toBe(false);
  });

  it("the run makes the folder, keeps where Connect carries on, then restarts", async () => {
    const r = rig();
    const out = await runStateFolderOwn(r.d, { hub: HUB });
    expect(r.did).toEqual([
      "give",
      `carry /s/state-abc123 ${HUB}`,
      "restart this install now has its own state folder",
    ]);
    expect(out).toMatchObject({ ok: true });
  });
});
