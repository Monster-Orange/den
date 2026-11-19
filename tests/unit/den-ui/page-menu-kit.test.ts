/**
 * den-ui, issue 555: the page action menu, and the row builder the kit's
 * own menus use (menuRowHtml, now exported), the checks that need no
 * browser.
 *
 *   - menuRowHtml is exported, and the kit's own menus (◐ ▾ and the
 *     account menu) draw exactly what they drew before: the same HTML,
 *     byte for byte (captured from the kit before the export).
 *   - pageMenuButtonHtml: "More ▾", the kit's button, a menu button.
 *   - pageMenuHtml draws the host's items from data: a link or a button
 *     each, a label as words or as a key in the kit's tables (a host adds
 *     its own keys with addStrings), a rule; a disabled item says so
 *     (aria-disabled) and is described by its note line, under it; a note
 *     with an href is a row of its own you can follow.
 *
 * The browser half (keys, focus back, a disabled item does nothing, the
 * look in light and dark at 1280 and 390) is kit-button-menu-row.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import {
  accountMenuHtml,
  appearanceMenuHtml,
  menuRowHtml,
  pageMenuButtonHtml,
  pageMenuHtml,
} from "../../../packages/den-ui/src/shell-html.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;

// The kit's own menus, drawn before menuRowHtml was exported.
const APPEARANCE_BEFORE =
  '<div class="den-ml" aria-hidden="true">Apariencia</div><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="false" type="button" data-kind="mode" data-value="system"><span class="den-mi-l">Sistema</span></button><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="true" type="button" data-kind="mode" data-value="dark"><span class="den-mi-l">Oscuro</span></button><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="false" type="button" data-kind="mode" data-value="light"><span class="den-mi-l">Claro</span></button><div class="den-hr" role="separator"></div><div class="den-ml" aria-hidden="true">Tema</div><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="true" type="button" data-kind="theme" data-value="den"><span class="den-mi-l">Den</span></button><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="false" type="button" data-kind="theme" data-value="x"><span class="den-mi-l">X &lt;y&gt;</span></button><p class="den-mnote" role="status">A note</p><div class="den-hr" role="separator"></div><div class="den-ml" aria-hidden="true">Idioma</div><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="true" type="button" data-kind="language" data-value="en"><span class="den-mi-l">English</span></button><button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="false" type="button" data-kind="language" data-value="ja"><span class="den-mi-l">日本語</span></button><div class="den-hr" role="separator"></div><a class="den-mi" tabindex="-1" role="menuitem" href="/settings" data-kind="item"><span class="den-mi-l">Settings</span></a><button class="den-mi" tabindex="-1" role="menuitem" type="button" data-kind="item" data-value="help"><span class="den-mi-l">Help</span></button>';
const ACCOUNT_BEFORE =
  '<div class="den-ml den-acct" data-nav-shape="name,login"><span class="den-acct-n">Sam</span><span class="den-acct-l">@sam</span><span class="den-acct-r">Owner</span></div><div class="den-hr" role="separator"></div><a class="den-mi" tabindex="-1" role="menuitem" href="/me" data-kind="item"><span class="den-mi-l">Profile</span></a><button class="den-mi" tabindex="-1" role="menuitem" type="button" data-kind="item" data-value="keys"><span class="den-mi-l">Keys</span></button><form class="den-mform" method="post" action="/out"><input type="hidden" name="csrf" value="t0k"><button type="submit" class="den-mi" tabindex="-1" role="menuitem"><span class="den-mi-l">Sign out</span></button></form>';

describe("menuRowHtml, exported: the kit's own menus are unchanged", () => {
  it("◐ ▾'s menu draws what it drew before the export", () => {
    expect(
      appearanceMenuHtml({
        mode: "dark",
        themes: [
          { value: "den", label: "Den", selected: true },
          { value: "x", label: "X <y>" },
        ],
        notice: "A note",
        languages: [
          { id: "en", name: "English", current: true },
          { id: "ja", name: "日本語" },
        ],
        items: [
          { label: "Settings", href: "/settings" },
          { label: "Help", id: "help" },
        ],
        lang: "es",
      }),
    ).toBe(APPEARANCE_BEFORE);
  });

  it("the account menu draws what it drew before the export", () => {
    expect(
      accountMenuHtml({
        name: "Sam",
        login: "sam",
        role: "Owner",
        items: [
          { label: "Profile", href: "/me" },
          { label: "Keys", id: "keys" },
          { label: "Sign out", action: { url: "/out", csrf: "t0k" } },
        ],
      }),
    ).toBe(ACCOUNT_BEFORE);
  });

  it("menuRowHtml: a radio, a link, a button, as the kit's menus draw them", () => {
    expect(
      menuRowHtml({
        label: "Dark",
        checked: true,
        kind: "mode",
        value: "dark",
      }),
    ).toBe(
      '<button class="den-mi" tabindex="-1" role="menuitemradio" aria-checked="true" type="button" data-kind="mode" data-value="dark"><span class="den-mi-l">Dark</span></button>',
    );
    expect(menuRowHtml({ label: "A & B", href: "/a" })).toBe(
      '<a class="den-mi" tabindex="-1" role="menuitem" href="/a"><span class="den-mi-l">A &amp; B</span></a>',
    );
    // New, for the page menu: disabled, its description, an id, a class.
    expect(
      menuRowHtml({
        label: "Download",
        kind: "page",
        value: "dl",
        disabled: true,
        describedBy: "m-dl-note",
        id: "m-dl",
        cls: "den-pmi",
      }),
    ).toBe(
      '<button class="den-mi den-pmi" tabindex="-1" role="menuitem" type="button" data-kind="page" data-value="dl" id="m-dl" aria-disabled="true" aria-describedby="m-dl-note"><span class="den-mi-l">Download</span></button>',
    );
    // A disabled link is a button: nothing to follow.
    expect(menuRowHtml({ label: "Open", href: "/o", disabled: true })).toBe(
      '<button class="den-mi" tabindex="-1" role="menuitem" type="button" aria-disabled="true"><span class="den-mi-l">Open</span></button>',
    );
  });
});

describe("the page action menu", () => {
  it("pageMenuButtonHtml: More ▾, the kit's button, a menu button", () => {
    expect(pageMenuButtonHtml({ id: "doc-more", lang: "en" })).toBe(
      '<button type="button" class="den-btn den-pmenu-btn" id="doc-more" aria-haspopup="menu" aria-expanded="false">More <span aria-hidden="true">▾</span></button>',
    );
    expect(pageMenuButtonHtml({ lang: "es", size: "sm" })).toBe(
      '<button type="button" class="den-btn sm den-pmenu-btn" id="den-pmenu" aria-haspopup="menu" aria-expanded="false">Más <span aria-hidden="true">▾</span></button>',
    );
    expect(pageMenuButtonHtml({ lang: "ja" })).toContain(">その他 <span");
  });

  const items = [
    { id: "edit", label: "Edit", href: "/doc/edit" },
    { id: "copy", label: { key: "kit.pmenu.test.copy" } },
    { hr: true },
    {
      id: "dl",
      label: "Download v3 (.md)",
      disabled: true,
      note: "Downloads are off. An admin can turn them on in Settings.",
      noteHref: "/settings#downloads",
    },
    {
      id: "pause",
      label: "Pause…",
      disabled: true,
      note: { key: "kit.pmenu.test.why", vars: { n: 2 } },
    },
    { id: "gone", label: "Gone", disabled: true },
  ];

  it("draws each item from data: links, buttons, a rule", () => {
    strings.addStrings("en", {
      "kit.pmenu.test.copy": "Copy link",
      "kit.pmenu.test.why": "Waits on {n} reviews.",
    });
    const h = pageMenuHtml({ id: "doc-more", items, lang: "en" });
    expect(h).toContain(
      '<a class="den-mi den-pmi" tabindex="-1" role="menuitem" href="/doc/edit" data-kind="page" data-value="edit" id="doc-more-edit"><span class="den-mi-l">Edit</span></a>',
    );
    expect(h).toContain(
      '<button class="den-mi den-pmi" tabindex="-1" role="menuitem" type="button" data-kind="page" data-value="copy" id="doc-more-copy"><span class="den-mi-l">Copy link</span></button>',
    );
    expect(h).toContain('<div class="den-hr" role="separator"></div>');
  });

  it("a disabled item: aria-disabled, described by its note right under it", () => {
    const h = pageMenuHtml({ id: "doc-more", items, lang: "en" });
    // A note with an href is a row of its own, to follow.
    expect(h).toContain(
      '<button class="den-mi den-pmi" tabindex="-1" role="menuitem" type="button" data-kind="page" data-value="dl" id="doc-more-dl" aria-disabled="true" aria-describedby="doc-more-dl-note"><span class="den-mi-l">Download v3 (.md)</span></button><a class="den-mi den-mwhy" tabindex="-1" role="menuitem" href="/settings#downloads" data-kind="note" data-value="dl" id="doc-more-dl-note"><span class="den-mi-l">Downloads are off. An admin can turn them on in Settings.</span></a>',
    );
    // A note with no href is a line, not a stop.
    expect(h).toContain(
      'id="doc-more-pause" aria-disabled="true" aria-describedby="doc-more-pause-note"><span class="den-mi-l">Pause…</span></button><p class="den-mnote den-mwhy" id="doc-more-pause-note">Waits on 2 reviews.</p>',
    );
    // No note: disabled, described by nothing.
    expect(h).toMatch(/id="doc-more-gone" aria-disabled="true"><span/);
  });

  it("an item with neither id nor label draws nothing; ids are safe", () => {
    const h = pageMenuHtml({
      id: 'm"x',
      items: [
        { label: "No id" },
        { id: "x" },
        { id: "a b", label: "Ok" },
      ] as never,
      lang: "en",
    });
    expect(h).toBe(
      '<button class="den-mi den-pmi" tabindex="-1" role="menuitem" type="button" data-kind="page" data-value="a b" id="m-x-a-b"><span class="den-mi-l">Ok</span></button>',
    );
  });

  it("its word is in all three tables", () => {
    expect([
      en["kit.pmenu.more"],
      es["kit.pmenu.more"],
      ja["kit.pmenu.more"],
    ]).toEqual(["More", "Más", "その他"]);
  });
});
