/**
 * den-ui 0.7.4 (issue 310): the person's own block, the first thing on a
 * product's Settings › Access, drawn the same in every product. The host
 * passes data; the kit owns every word and format.
 *
 *   accountPanelHtml({ name?, login?, role?, how, signOut?, lang? })
 *
 * In this order:
 * 1. A heading: the name, else @login, else the kit's word for this
 *    computer ("Local"), as accountWho words them.
 * 2. @login and the role ("@login · Owner"). @login is left out when it
 *    is already the heading. role is a key (owner, admin, member, guest)
 *    the kit words in its catalog (kit.role.<key>); any other value is
 *    shown as given.
 * 3. How this browser is signed in: how is "github", "local" or "paired".
 * 4. Sign out: a form that posts to signOut.url on its own, with no
 *    script, signOut.csrf in a hidden field (signOut.field, "csrf" by
 *    default). Left out when signOut is absent: a local browser can't
 *    sign out.
 * Every value is escaped. Its look is in shell.css (.den-acctp), theme
 * tokens only.
 */
import { esc, kitT } from "./strings.js";
import { accountWho } from "./shell-html.js";

/** The ways a browser can be signed in, as the kit words them. */
export const ACCOUNT_HOWS = ["github", "local", "paired"];

/** The role keys the kit has words for. */
export const ACCOUNT_ROLES = ["owner", "admin", "member", "guest"];

/** The kit's word for a role key in `lang`; any other value as given. */
export function roleWord(role, lang) {
  if (role == null || role === "") return "";
  const key = String(role).toLowerCase();
  return ACCOUNT_ROLES.includes(key)
    ? kitT(lang, "kit.role." + key)
    : String(role);
}

export function accountPanelHtml({
  name,
  login,
  role,
  how,
  signOut,
  lang,
} = {}) {
  // The heading and @login as the rail's entry words them; with neither,
  // the kit's word for this computer.
  const who = accountWho({ name, login, local: true, lang });
  const heading = who.lines[0];
  const at = who.lines[1] || "";
  const r = roleWord(role, lang);
  const line = [at, r].filter(Boolean);
  const kind = ACCOUNT_HOWS.includes(how) ? how : "";
  const parts = [
    '<h3 class="den-acctp-h">' + esc(heading) + "</h3>",
    line.length
      ? '<p class="den-acctp-who">' +
        (at ? '<span class="den-acctp-l">' + esc(at) + "</span>" : "") +
        (at && r
          ? '<span class="den-acctp-sep" aria-hidden="true"> · </span>'
          : "") +
        (r ? '<span class="den-acctp-r">' + esc(r) + "</span>" : "") +
        "</p>"
      : "",
    kind
      ? '<p class="den-acctp-how">' +
        esc(kitT(lang, "kit.acctp." + kind)) +
        "</p>"
      : "",
    signOut && signOut.url
      ? '<form class="den-acctp-out" method="post" action="' +
        esc(signOut.url) +
        '">' +
        (signOut.csrf != null
          ? '<input type="hidden" name="' +
            esc(signOut.field || "csrf") +
            '" value="' +
            esc(signOut.csrf) +
            '">'
          : "") +
        '<button type="submit" class="den-acctp-btn">' +
        esc(kitT(lang, "kit.acctp.signOut")) +
        "</button></form>"
      : "",
  ];
  return (
    '<section class="den-acctp" data-den-account-panel' +
    (kind ? ' data-how="' + kind + '"' : "") +
    ">" +
    parts.join("") +
    "</section>"
  );
}
