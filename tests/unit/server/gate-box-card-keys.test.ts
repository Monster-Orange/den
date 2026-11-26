/**
 * gate_box_set's Allow card (issue 625 follow-up): its message keys are
 * built at run time (`ap.det.gate_box_set.<field>`), so the i18n parity
 * check, which reads keys written out in full, never sees them. This runs
 * the real check for a new box and for a replaced one, and needs every
 * key on the card in en, es and ja, with the vars the card passes. Each
 * English line must also be the card's own English details line, so the
 * two can't drift apart.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateBoxOps } from "../../../src/ui/server/gate-routes.js";
import { UI_LANGUAGES } from "../../../src/shared/ui-language.js";

type Table = Record<string, string>;
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/** window.denMessages after the language files and shell.js run. */
function catalogs(): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  const files = [
    ...UI_LANGUAGES.filter((l) => l !== "en").map((l) => `i18n/${l}.js`),
    "shell.js",
  ];
  for (const f of files)
    try {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx, {
        filename: f,
      });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  return window.denMessages as Record<string, Table>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-gbk-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const store = new GateStore({ dir: tmp });
const ops = gateBoxOps({ store: () => store, audit: (() => ({})) as never });

const BOX = {
  name: "box1",
  ssh: "runner@box1.example",
  ssh_port: 2222,
  ssh_identity: "/keys/box1",
  playwright: "ws://box1.example:3000/",
  browser_slots: 3,
  hold_file: "/tmp/den-hold",
  time_scale: 2,
  playwright_version: "1.48.0",
  min_free_mem_mb: 4096,
};

type Card = {
  details: string[];
  detailKeys: { key: string; vars?: Record<string, string> }[];
};
const card = async (box: Record<string, unknown>): Promise<Card> => {
  const c = await ops.set.check({ box });
  if (!c.ok) throw new Error(c.error);
  return c as unknown as Card;
};
const fill = (s: string, vars: Record<string, string> = {}) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
const varsOf = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("gate_box_set's Allow card keys", () => {
  const messages = catalogs();

  it("every key, for a new box and a replaced one, is in every language with the card's vars", async () => {
    const added = await card(BOX);
    // Unset fields too: the card shows each field, set or not.
    const bare = await card({ name: "box2", ssh: "runner@box2.example" });
    await ops.set.run({ box: BOX });
    const replaced = await card(BOX);
    const keys = new Map<string, string[]>();
    for (const c of [added, bare, replaced]) {
      expect(c.detailKeys).toHaveLength(c.details.length);
      for (const k of c.detailKeys)
        keys.set(k.key, Object.keys(k.vars ?? {}).sort());
    }
    expect([...keys.keys()]).toEqual(
      expect.arrayContaining([
        "ap.det.gate_box_set.adds",
        "ap.det.gate_box_set.replaces",
        "ap.det.gate_box_set.slots",
      ]),
    );
    const missing: string[] = [];
    for (const lang of UI_LANGUAGES)
      for (const [key, vars] of keys) {
        const s = messages[lang]?.[key];
        if (s === undefined) missing.push(`${lang}: ${key}`);
        else if (JSON.stringify(varsOf(s)) !== JSON.stringify(vars))
          missing.push(`${lang}: ${key} has {${varsOf(s).join(",")}}`);
      }
    expect(missing).toEqual([]);
  });

  it("each English line is the card's own details line", async () => {
    for (const c of [await card({ ...BOX, name: "box3" }), await card(BOX)])
      c.detailKeys.forEach((k, i) =>
        expect(fill(messages.en[k.key] ?? "", k.vars)).toBe(c.details[i]),
      );
  });
});
