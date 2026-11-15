/**
 * Issue 164: after a link, ONE result line (not one per project): how many
 * were linked, and which couldn't be, with what to do. Pure; the browser
 * test shows the real words.
 */
import { describe, expect, it } from "@jest/globals";

const tt = (k: string, v?: Record<string, unknown>) =>
  `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;
const mod = () =>
  import("../../../src/ui/server/public/settings-registry.js") as Promise<{
    hubLinkResultText: (
      r: unknown,
      t: typeof tt,
      join?: (n: string[]) => string,
    ) => string;
  }>;

describe("hubLinkResultText (issue 164)", () => {
  it("several projects: one line", async () => {
    const { hubLinkResultText } = await mod();
    const out = hubLinkResultText(
      {
        linked: [
          { project: "a", hub: {} },
          { project: "b", hub: {} },
          { project: "c", hub: {} },
        ],
        skipped: [],
      },
      tt,
    );
    expect(out).toBe("[hubla.linked:3]");
    expect(out).not.toContain("\n");
  });

  it("one fails: one line with the count linked, the name and a retry", async () => {
    const { hubLinkResultText } = await mod();
    const out = hubLinkResultText(
      {
        linked: [
          { project: "a", hub: {} },
          { project: "b", hub: {} },
        ],
        skipped: [{ project: "north", code: "offline", why: "x" }],
      },
      tt,
    );
    expect(out).toBe("[hubla.linked:2] [hubla.failed:1|north]");
  });

  it("nothing linked, one failed: just the failure; already linked is no failure", async () => {
    const { hubLinkResultText } = await mod();
    expect(
      hubLinkResultText(
        { linked: [], skipped: [{ project: "n", code: "stale", why: "" }] },
        tt,
      ),
    ).toBe("[hubla.failedAll:n]");
    expect(
      hubLinkResultText(
        {
          linked: [{ project: "a", hub: {} }],
          skipped: [{ project: "b", code: "linked", why: "" }],
        },
        tt,
      ),
    ).toBe("[hubla.linked:1]");
  });
});
