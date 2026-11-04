import { describe, expect, it } from "@jest/globals";
import { parseGraphFlags } from "../../../src/ui/cli/graph-command.js";

describe("parseGraphFlags", () => {
  it("applies defaults with no args", () => {
    expect(parseGraphFlags([])).toEqual({
      all: false,
      source: "derived",
      kind: "all",
      format: "text",
      diff: false,
      refresh: false,
      order: "up",
    });
  });

  it("accepts every valid --source/--kind/--format value", () => {
    for (const source of ["derived", "declared", "union"]) {
      expect(parseGraphFlags([`--source=${source}`]).source).toBe(source);
    }
    for (const kind of ["all", "hard", "infra", "http", "event"]) {
      expect(parseGraphFlags([`--kind=${kind}`]).kind).toBe(kind);
    }
    for (const format of ["text", "json", "dot"]) {
      expect(parseGraphFlags([`--format=${format}`]).format).toBe(format);
    }
  });

  it("rejects a typo'd value, listing the valid choices", () => {
    expect(() => parseGraphFlags(["--format=jsonn"])).toThrow(
      /Invalid value for --format: "jsonn" \(valid: text \| json \| dot\)/,
    );
    expect(() => parseGraphFlags(["--source=derved"])).toThrow(
      /Invalid value for --source: "derved" \(valid: derived \| declared \| union\)/,
    );
    expect(() => parseGraphFlags(["--kind=htp"])).toThrow(
      /Invalid value for --kind: "htp" \(valid: all \| hard \| infra \| http \| event\)/,
    );
  });

  it("rejects an empty value", () => {
    expect(() => parseGraphFlags(["--format="])).toThrow(
      /Invalid value for --format/,
    );
  });

  it("still parses boolean flags and the repo positional", () => {
    const flags = parseGraphFlags(["my-repo", "--diff", "--refresh", "-d"]);
    expect(flags.repo).toBe("my-repo");
    expect(flags.diff).toBe(true);
    expect(flags.refresh).toBe(true);
    expect(flags.order).toBe("down");
  });
});
