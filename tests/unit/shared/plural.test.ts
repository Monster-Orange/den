/** Counts in CLI output read "1 repo" and "3 repos", never "1 repos". */
import { describe, expect, it } from "@jest/globals";
import { noun, plural } from "../../../src/shared/plural.js";

describe("plural", () => {
  it("one is singular; zero and many are plural", () => {
    expect(plural(1, "repo")).toBe("1 repo");
    expect(plural(0, "repo")).toBe("0 repos");
    expect(plural(3, "workspace")).toBe("3 workspaces");
  });

  it("takes an irregular plural", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
  });

  it("noun gives the word alone, for a count rendered apart", () => {
    expect(noun(1, "system")).toBe("system");
    expect(noun(4, "system")).toBe("systems");
  });
});
