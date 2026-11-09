/**
 * D17: web.owner_github, recorded from gh at `web up` and `service install`
 * when no owner is linked and it isn't set; never over a value already
 * there, never with an owner linked; nothing when gh can't say.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ownerGithubLine,
  recordOwnerGithub,
} from "../../../src/shared/owner-github.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

function store(start: Record<string, unknown> = {}) {
  let cfg = start as UserConfig;
  const writes: UserConfig[] = [];
  return {
    read: () => cfg,
    write: (c: UserConfig) => {
      writes.push(c);
      cfg = c;
    },
    writes,
  };
}

describe("recordOwnerGithub", () => {
  it("records gh's login, keeping the rest of web and the file", () => {
    const s = store({ editor: "vscode", web: { machine_name: "Studio" } });
    const r = recordOwnerGithub({
      ownerLinked: () => false,
      ghLogin: () => "octo",
      read: s.read,
      write: s.write,
    });
    expect(r).toEqual({ state: "recorded", login: "octo" });
    expect(s.writes).toEqual([
      {
        editor: "vscode",
        web: { machine_name: "Studio", owner_github: "octo" },
      },
    ]);
    expect(ownerGithubLine(r)).toContain("@octo");
  });

  it("leaves a value already set, an owner already linked, and a silent gh alone", () => {
    const set = store({ web: { owner_github: "someone" } });
    const gh = () => {
      throw new Error("gh must not run");
    };
    expect(
      recordOwnerGithub({ ownerLinked: () => false, ghLogin: gh, ...set }),
    ).toEqual({ state: "set", login: "someone" });
    const linked = store();
    expect(
      recordOwnerGithub({ ownerLinked: () => true, ghLogin: gh, ...linked }),
    ).toEqual({ state: "linked" });
    const none = store();
    expect(
      recordOwnerGithub({
        ownerLinked: () => false,
        ghLogin: () => null,
        ...none,
      }),
    ).toEqual({ state: "none" });
    expect([...set.writes, ...linked.writes, ...none.writes]).toEqual([]);
    expect(ownerGithubLine({ state: "set", login: "someone" })).toBeNull();
    // gh can't say: the plain fix, once (Vision's D17 review).
    expect(ownerGithubLine({ state: "none" }, "acme")).toBe(
      "GitHub owner: not known, because gh isn't signed in here. Run `gh auth login`, then `acme web restart`; or set web.owner_github: <your GitHub login> in config/local/user.yml. Then you can connect your GitHub account from any browser.",
    );
  });
});
