import { describe, expect, it } from "@jest/globals";
import { defaultInstallLabel } from "../../../src/ui/server/hub-connect.js";

const RULE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

describe("issue 1632 part 4: the install label Hub shows", () => {
  it("is the person's machine name when one is set, else the short hostname", () => {
    expect(
      defaultInstallLabel("acme", "box-7.local", { machineName: "Studio" }),
    ).toBe("acme on Studio");
    expect(defaultInstallLabel("acme", "box-7.local", {})).toBe(
      "acme on box-7",
    );
  });

  it("gains a short id of its state folder when another install is on this login", () => {
    const a = defaultInstallLabel("acme", "box-7.local", {
      stateDir: "/s/one",
      others: 1,
    });
    const b = defaultInstallLabel("acme", "box-7.local", {
      stateDir: "/s/two",
      others: 1,
    });
    expect(a).toMatch(/^acme on box-7 [0-9a-f]{4}$/);
    expect(a).not.toBe(b);
    expect(
      defaultInstallLabel("acme", "box-7.local", {
        stateDir: "/s/one",
        others: 1,
      }),
    ).toBe(a);
  });

  it("keeps the id within Hub's 40 characters, whatever the name", () => {
    const l = defaultInstallLabel("acme", "x", {
      machineName: "A very long machine name for a test box",
      stateDir: "/s/one",
      others: 2,
    });
    expect(l).toMatch(RULE);
    expect(l).toMatch(/ [0-9a-f]{4}$/);
  });
});
