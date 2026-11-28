import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { checksHtml } from "../../../packages/den-ui/src/checks.js";
import * as strings from "../../../packages/den-ui/src/strings.js";
import { KIT_FILES } from "../../../src/ui/server/ui-assets.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;

const items = [
  { value: "a", label: "Alpha", help: "First one." },
  { value: "b", label: "Beta", help: "Second one." },
  { value: "c", label: "Gamma" },
];

const attrs = (tag: string) =>
  Object.fromEntries(
    [...tag.matchAll(/([a-z-]+)(?:="([^"]*)")?/g)].map((m) => [
      m[1],
      m[2] ?? "",
    ]),
  );
const inputs = (html: string) =>
  [...html.matchAll(/<input [^>]*>/g)].map((m) => attrs(m[0]));
const labels = (html: string) =>
  [...html.matchAll(/<label [^>]*>/g)].map((m) => attrs(m[0]));

describe("checksHtml", () => {
  const html = checksHtml({
    id: "jobs",
    legend: "Who",
    items,
    checked: ["b"],
  });

  it("is a fieldset with a legend", () => {
    expect(html).toMatch(/<fieldset class="den-checks" id="jobs"/);
    expect(html).toMatch(/<legend class="den-checks-legend">Who<\/legend>/);
  });

  it("ties each whole-row label to its own checkbox", () => {
    const ins = inputs(html);
    const ls = labels(html);
    expect(ins).toHaveLength(items.length);
    expect(ls).toHaveLength(items.length);
    const ids = ins.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    ls.forEach((l, n) => expect(l.for).toBe(ins[n].id));
    ins.forEach((i, n) =>
      expect(html).toContain(`id="${i["aria-labelledby"]}">${items[n].label}<`),
    );
    ins.forEach((i, n) => {
      expect(i.type).toBe("checkbox");
      expect(i.value).toBe(items[n].value);
    });
  });

  it("describes a box by its help line, and only when it has one", () => {
    const ins = inputs(html);
    for (const [n, it] of items.entries()) {
      const desc = ins[n]["aria-describedby"];
      if (!it.help) {
        expect(desc).toBeUndefined();
        continue;
      }
      expect(html).toContain(`id="${desc}">${it.help}<`);
    }
  });

  it("ticks only the checked values", () => {
    expect(inputs(html).map((i) => "checked" in i)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("disables every box and marks the list", () => {
    const off = checksHtml({ legend: "Who", items, disabled: true });
    expect(inputs(off).every((i) => "disabled" in i)).toBe(true);
    expect(off).toMatch(/<fieldset [^>]*data-disabled/);
  });

  it("draws no row for an item with no label", () => {
    const h = checksHtml({
      legend: "Who",
      items: [...items, { value: "d", label: " " }],
    });
    expect(inputs(h)).toHaveLength(items.length);
  });

  it("escapes the host's words", () => {
    const h = checksHtml({
      legend: "<b>",
      items: [{ value: '"x', label: "<i>", help: "&" }],
    });
    expect(h).not.toMatch(/<b>|<i>/);
    expect(h).toContain("&lt;i&gt;");
    expect(h).toContain('value="&quot;x"');
  });

  it("describes the fieldset by its intro lines", () => {
    const h = checksHtml({
      id: "j",
      legend: "Who",
      items,
      intro: ["One.", "Two."],
    });
    const fs0 = /<fieldset [^>]*>/.exec(h)![0];
    const ids = attrs(fs0)["aria-describedby"].split(" ");
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(h).toContain(`id="${id}"`);
  });

  it("puts the note and its button outside the fieldset", () => {
    const h = checksHtml({
      legend: "Who",
      items,
      disabled: true,
      note: "Can't read.",
      noteAction: { label: "Again" },
    });
    const inside = /<fieldset[\s\S]*<\/fieldset>/.exec(h)![0];
    expect(inside).not.toContain("den-checks-note");
    expect(inside).not.toContain("den-checks-act");
    expect(h).toMatch(
      /<button type="button" class="den-btn sm den-checks-act"/,
    );
  });
});

describe("the kit's words and wiring", () => {
  it("has its refusal word in en, es and ja, each with {reason}", () => {
    for (const t of [en, es, ja]) {
      expect(t["kit.checks.refused"]).toBeTruthy();
      expect(t["kit.checks.refused"]).toContain("{reason}");
    }
    expect(new Set([en, es, ja].map((t) => t["kit.checks.refused"])).size).toBe(
      3,
    );
  });

  it("is served by Den and exported by the package", () => {
    expect(KIT_FILES).toEqual(
      expect.arrayContaining(["checks.js", "checks.css"]),
    );
    const pkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../../packages/den-ui/package.json"),
        "utf-8",
      ),
    ) as { exports: Record<string, string> };
    expect(pkg.exports["./checks"]).toBe("./src/checks.js");
    expect(pkg.exports["./checks.css"]).toBe("./src/checks.css");
  });
});
