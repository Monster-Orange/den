import { describe, expect, it } from "@jest/globals";
import {
  navItemHtml,
  type NavItem,
} from "../../../packages/den-ui/src/shell-html.js";
import { en, es, ja } from "../../../packages/den-ui/src/strings.js";

const badge = (h: string) =>
  /<span class="den-bdg[^"]*"[^>]*>/.exec(h)?.[0] ?? "";
const titleOf = (tag: string) => /title="([^"]*)"/.exec(tag)?.[1] ?? null;
const name = (h: string) => /<a [^>]*aria-label="([^"]*)"/.exec(h)?.[1] ?? null;
const entry = (b: NonNullable<NavItem["badge"]>, lang = "en") =>
  navItemHtml({ id: "a", label: "Agents", href: "/a", badge: b }, "page", lang);

describe("issue 561: a waiting badge's title", () => {
  it("names who it waits on, in en, es and ja", () => {
    for (const [lang, want] of [
      ["en", "3 waiting on you"],
      ["es", "3 esperan tu respuesta"],
      ["ja", "あなたの対応待ち 3 件"],
    ] as const) {
      const t = badge(entry({ n: 3, what: "waiting" }, lang));
      expect([lang, titleOf(t)]).toEqual([lang, want]);
      expect(t).toContain('aria-hidden="true"');
    }
  });

  it("one is singular in es", () => {
    expect(titleOf(badge(entry({ n: 1, what: "waiting" }, "es")))).toBe(
      "1 espera tu respuesta",
    );
  });

  it("keeps the shown count: 99+ reads as 99+", () => {
    expect(titleOf(badge(entry({ n: "99+", what: "waiting" })))).toBe(
      "99+ waiting on you",
    );
  });

  it("aria words are unchanged", () => {
    expect(name(entry({ n: 3, what: "waiting" }))).toBe("Agents, 3 waiting");
    expect(name(entry({ n: 3, what: "waiting" }, "ja"))).toBe(
      "Agents, 3 件待機中",
    );
  });

  it("other badges, and no count, get no title", () => {
    for (const b of [
      { n: 3 },
      { n: 3, what: "open" },
      { n: 3, what: "down" },
      { n: 3, what: "running" },
      { n: "", what: "waiting" },
    ] as NonNullable<NavItem["badge"]>[])
      expect([b, titleOf(badge(entry(b)))]).toEqual([b, null]);
  });

  it("the words are the kit's, in every language", () => {
    for (const t of [en, es, ja])
      expect(
        (t as Record<string, string>)["kit.badge.waiting.title"],
      ).toContain("{n}");
  });
});
