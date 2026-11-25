import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as registry from "../../../src/ui/server/public/settings-registry.js";

const PINNED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "../../fixtures/settings-registry-order.json"),
    "utf-8",
  ),
) as {
  rows: [string, string][];
  categories: [string, number][];
  exports: string[];
};

const mod = registry as unknown as Record<string, unknown>;
const rows = mod.DEN_SETTINGS as { id: string; category: string }[];
const cats = mod.DEN_SETTING_CATEGORIES as { id: string; order: number }[];

describe("settings-registry keeps its rows, categories and exports as pinned", () => {
  it("every row id and its category, in today's order", () => {
    expect(rows.map((r) => [r.id, r.category])).toEqual(PINNED.rows);
  });

  it("the categories and their order", () => {
    expect(cats.map((c) => [c.id, c.order])).toEqual(PINNED.categories);
  });

  it("the same exported names", () => {
    expect(Object.keys(mod).sort()).toEqual(PINNED.exports);
  });
});
