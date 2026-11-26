/**
 * den-ui, issue 750: the group header, for any list that shows agents by
 * group (Den's agents page; Hub's too). Pure: a group's name that opens
 * the group in Hub (a new tab), its lead marked, a count, and one action
 * (Message group: a link-button to Hub's composer, a new tab). The host
 * gives every word; the kit escapes them. Tokens only in its stylesheet.
 */
import { describe, expect, it } from "@jest/globals";
import { groupHeaderHtml } from "../../../packages/den-ui/src/group-header.js";
import { KIT_FILES, KIT_PAGE_CSS } from "../../../src/ui/server/ui-assets.js";

const base = {
  name: "Web <Delivery>",
  slug: "web-delivery",
  href: "https://hub.example.test/acme/groups/web-delivery",
  openLabel: "Open Web <Delivery> in Hub",
  lead: "Lead: Web Planner",
  count: 3,
  action: {
    label: "Message group",
    href: "https://hub.example.test/acme/groups/web-delivery?compose=1",
    name: "Message Web <Delivery> in Hub",
  },
};

describe("groupHeaderHtml (group-header.js)", () => {
  it("the name opens the group in Hub, in a new tab", () => {
    const h = groupHeaderHtml(base);
    expect(h).toContain('data-group="web-delivery"');
    expect(h).toContain(
      '<a class="den-grph-name" href="https://hub.example.test/acme/groups/web-delivery" target="_blank" rel="noopener noreferrer" title="Open Web &lt;Delivery&gt; in Hub">Web &lt;Delivery&gt;</a>',
    );
  });

  it("with no link: the name as text", () => {
    const h = groupHeaderHtml({ ...base, href: null });
    expect(h).toContain(
      '<span class="den-grph-name">Web &lt;Delivery&gt;</span>',
    );
  });

  it("the lead is marked", () => {
    expect(groupHeaderHtml(base)).toContain(
      '<span class="den-grph-lead" data-lead><span class="den-grph-mark" aria-hidden="true">★</span>Lead: Web Planner</span>',
    );
    expect(groupHeaderHtml({ ...base, lead: null })).not.toContain(
      "den-grph-lead",
    );
  });

  it("Message group is a link-button to Hub's composer, in a new tab", () => {
    expect(groupHeaderHtml(base)).toContain(
      '<a class="den-btn sm den-grph-act" href="https://hub.example.test/acme/groups/web-delivery?compose=1" target="_blank" rel="noopener noreferrer" aria-label="Message Web &lt;Delivery&gt; in Hub">Message group</a>',
    );
    expect(groupHeaderHtml({ ...base, action: null })).not.toContain(
      "den-grph-act",
    );
  });

  it("only an http(s) link is a link", () => {
    const h = groupHeaderHtml({
      ...base,
      href: "javascript:alert(1)",
      action: { ...base.action, href: "data:text/html,x" },
    });
    expect(h).not.toContain("javascript:");
    expect(h).not.toContain("data:");
  });

  it("the count", () => {
    expect(groupHeaderHtml(base)).toContain(
      '<span class="den-grph-n">3</span>',
    );
  });
});

describe("group-header.css and Den's serving of it", () => {
  it("Den serves it and links it on every page with the frame", () => {
    expect(KIT_FILES).toEqual(
      expect.arrayContaining(["group-header.js", "group-header.css"]),
    );
    expect(KIT_PAGE_CSS).toContain("/kit/group-header.css");
  });
});
