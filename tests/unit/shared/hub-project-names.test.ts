/**
 * 0.4.45: a project linked to Hub shows Hub's name, and a rename in Hub
 * reaches Den without a restart. Den asks Hub for its projects at start,
 * on connect and every hub.names_check_seconds (default 300), and rewrites
 * a link whose Hub name or slug changed. A Hub project that is gone, or a
 * Hub that doesn't answer, changes nothing (doctor speaks to those).
 */
import { describe, expect, it } from "@jest/globals";
import type { HubProjectLink } from "../../../src/shared/hub-project-link.js";
import { refreshHubNames } from "../../../src/shared/hub-project-names.js";
import { readHubConfig } from "../../../src/shared/hub.js";

const L = (id: string, slug: string, name: string): HubProjectLink => ({
  id,
  slug,
  name,
});

function deps(
  links: Record<string, HubProjectLink>,
  hub: { id: string; slug: string; name: string }[] | null | "throw",
) {
  const written: Record<string, HubProjectLink> = {};
  return {
    written,
    d: {
      linked: () => Object.entries(links),
      hubProjects: async () => {
        if (hub === "throw") throw new Error("502");
        return hub;
      },
      write: (ws: string, l: HubProjectLink) => {
        written[ws] = l;
      },
    },
  };
}

describe("Hub's names reach Den", () => {
  it("a renamed Hub project: the link takes the new name and slug; the rest stay", async () => {
    const t = deps(
      {
        den: L("p1", "den", "den"),
        "den-hub": L("p2", "den-hub", "Den Hub"),
        web: L("p3", "web", "Web"),
      },
      [
        { id: "p1", slug: "den", name: "Den" },
        { id: "p2", slug: "den-hub", name: "Den Hub" },
        { id: "p3", slug: "site", name: "Site" },
      ],
    );
    expect(await refreshHubNames(t.d)).toEqual(["den", "web"]);
    expect(t.written).toEqual({
      den: L("p1", "den", "Den"),
      web: L("p3", "site", "Site"),
    });
  });

  it("gone from Hub, or Hub doesn't answer: nothing changes", async () => {
    for (const hub of [[], null, "throw"] as const) {
      const t = deps({ den: L("p1", "den", "den") }, hub as never);
      expect(await refreshHubNames(t.d)).toEqual([]);
      expect(t.written).toEqual({});
    }
  });

  it("hub.names_check_seconds: 300 unset, at least 5", () => {
    const url = "https://hub.example.test";
    const none = () => ({});
    expect(readHubConfig({ hub: { url } }, {}, none)?.namesCheckSeconds).toBe(
      300,
    );
    expect(
      readHubConfig({ hub: { url, names_check_seconds: 60 } }, {}, none)
        ?.namesCheckSeconds,
    ).toBe(60);
    expect(() =>
      readHubConfig({ hub: { url, names_check_seconds: 1 } }, {}, none),
    ).toThrow("hub.names_check_seconds must be a number, at least 5");
  });
});

/**
 * Issue 167 (mock v6 A6): each check is recorded: when Hub last answered,
 * and when it last didn't, so the Name row can say Hub can't be reached
 * and how old the name is.
 */
describe("the last check of Hub's names", () => {
  it("says whether Hub answered", async () => {
    const seen: boolean[] = [];
    const links = { north: L("p1", "north", "North") };
    for (const hub of [
      [{ id: "p1", slug: "north", name: "North" }],
      null,
      "throw",
    ] as const) {
      const t = deps(links, hub as never);
      await refreshHubNames({ ...t.d, checked: (ok) => void seen.push(ok) });
    }
    expect(seen).toEqual([true, false, false]);
  });

  it("is kept in the state folder: the last good time and the last failure", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const { recordHubNamesCheck, readHubNamesCheck } =
      await import("../../../src/shared/hub-project-names.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-names-"));
    try {
      expect(readHubNamesCheck(dir)).toEqual({});
      recordHubNamesCheck(dir, true, new Date("2026-11-15T10:00:00Z"));
      recordHubNamesCheck(dir, false, new Date("2026-11-15T10:12:00Z"));
      expect(readHubNamesCheck(dir)).toEqual({
        okAt: "2026-11-15T10:00:00.000Z",
        failAt: "2026-11-15T10:12:00.000Z",
      });
      recordHubNamesCheck(dir, true, new Date("2026-11-15T10:15:00Z"));
      expect(readHubNamesCheck(dir)).toEqual({
        okAt: "2026-11-15T10:15:00.000Z",
        failAt: "2026-11-15T10:12:00.000Z",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
