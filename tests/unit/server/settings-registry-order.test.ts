import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as registry from "../../../src/ui/server/public/settings-registry.js";

const FIXTURE = path.join(
  __dirname,
  "../../fixtures/settings-registry-order.json",
);

type Pinned = {
  rows: [string, string][];
  categories: [string, number][];
  exports: string[];
};

const mod = registry as unknown as Record<string, unknown>;
const rows = mod.DEN_SETTINGS as { id: string; category: string }[];
const cats = mod.DEN_SETTING_CATEGORIES as { id: string; order: number }[];

const NOW: Pinned = {
  rows: rows.map((r) => [r.id, r.category]),
  categories: cats.map((c) => [c.id, c.order]),
  exports: Object.keys(mod).sort(),
};

const WRITE = process.env.DEN_SETTINGS_PIN_WRITE === "1";
if (WRITE) fs.writeFileSync(FIXTURE, JSON.stringify(NOW, null, 2) + "\n");

const PINNED = JSON.parse(fs.readFileSync(FIXTURE, "utf-8")) as Pinned;

const REFRESH =
  "Only if you meant to add, remove or reorder a setting, a category or an " +
  "export, refresh the pinned list with: node scripts/settings-pin.mjs --write";

function same<T>(got: T, want: T): void {
  try {
    expect(got).toEqual(want);
  } catch (e) {
    throw new Error(`${REFRESH}\n\n${(e as Error).message}`);
  }
}

describe("settings-registry keeps its rows, categories and exports as pinned", () => {
  it("every row id and its category, in today's order", () => {
    same(NOW.rows, PINNED.rows);
  });

  it("the categories and their order", () => {
    same(NOW.categories, PINNED.categories);
  });

  it("the same exported names", () => {
    same(NOW.exports, PINNED.exports);
  });
});
