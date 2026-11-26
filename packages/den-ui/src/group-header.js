/**
 * The group header (issue 750): one group's line in a list that shows
 * agents by group, for Den's agents page and Hub's own lists. Pure (no
 * DOM): it runs in Node and in the page.
 *
 *   groupHeaderHtml({
 *     name,              the group's name (escaped)
 *     slug,              its slug (data-group)
 *     href,              its page in Hub: the name opens it in a new tab
 *     openLabel,         the name link's title ("Open … in Hub")
 *     lead,              "Lead: …", the host's words; null: no lead
 *     count,             how many rows follow it
 *     action: { label, href, name },   Message group: a small link-button
 *                        to Hub's composer, in a new tab; null: none
 *   })
 *
 * Only an http(s) address becomes a link. Link group-header.css after
 * tokens.css and button.css.
 */
import { esc } from "./strings.js";
import { buttonClass } from "./button.js";

const NEW_TAB = ' target="_blank" rel="noopener noreferrer"';

/** An http(s) address, else null. */
function httpUrl(v) {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? v : null;
  } catch {
    return null;
  }
}

export function groupHeaderHtml({
  name,
  slug,
  href,
  openLabel,
  lead,
  count,
  action,
} = {}) {
  const open = httpUrl(href);
  const nm = open
    ? '<a class="den-grph-name" href="' +
      esc(open) +
      '"' +
      NEW_TAB +
      (openLabel ? ' title="' + esc(openLabel) + '"' : "") +
      ">" +
      esc(name) +
      "</a>"
    : '<span class="den-grph-name">' + esc(name) + "</span>";
  const ld = lead
    ? '<span class="den-grph-lead" data-lead><span class="den-grph-mark" aria-hidden="true">★</span>' +
      esc(lead) +
      "</span>"
    : "";
  const n =
    typeof count === "number"
      ? '<span class="den-grph-n">' + esc(count) + "</span>"
      : "";
  const go = action && httpUrl(action.href);
  const act = go
    ? '<a class="' +
      buttonClass("secondary", "sm") +
      ' den-grph-act" href="' +
      esc(go) +
      '"' +
      NEW_TAB +
      (action.name ? ' aria-label="' + esc(action.name) + '"' : "") +
      ">" +
      esc(action.label) +
      "</a>"
    : "";
  return (
    '<div class="den-grph"' +
    (slug ? ' data-group="' + esc(slug) + '"' : "") +
    ">" +
    '<span class="den-grph-t">' +
    nm +
    ld +
    "</span>" +
    '<span class="den-grph-r">' +
    act +
    n +
    "</span></div>"
  );
}
