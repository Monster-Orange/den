# den-ui

The UI kit Den is built from: design tokens, self-hosted fonts and, over
time, the components more than one product needs. It is framework-free:
plain CSS custom properties, ES modules and custom elements, with no build
step at runtime.

It lives in Den's repository as a workspace package and ships inside Den.
Another product consumes it by pinning an exact version and bundling its
own copy, so a page never mixes two versions.

## What's in it

- `src/tokens.css`: colour (light and dark), type, radius, shadow,
  spacing, motion, layers and touch targets, as CSS custom properties.
  Light is the default. `data-mode="light"` or `"dark"` on `<html>` picks a
  mode; with none set, the kit follows `prefers-color-scheme`. Every rule
  has zero specificity (`:where()`), so a theme laid on top always wins.
- `src/fonts.css`: Rubik (400, 500) and Space Mono (400), latin and
  latin-ext, as woff2, `font-display: swap`. Nothing is fetched from a
  third party. Japanese uses the system's fonts.
- `src/base.css`: one reduced-motion rule (every duration token goes to 0) and Japanese line breaking.
- `src/time.js` (export `./time`): date-times for people, in their own
  time zone. `formatTime(iso, opts)` gives the text, `timeHtml(iso, opts)`
  a `<time>` with the UTC stamp in `datetime` and the full local time and
  zone in `title`. `opts`: `style` (`datetime`, `date`, `time`,
  `relative`), `seconds`, `zone`, `locale`, `now`. The zone is `opts.zone`,
  else `<html data-den-tz>`, else `setTimeZone`'s pick, else the browser's.
  `upgradeTimes(root)` draws every `time[data-den-time]` again after a
  change. The year shows only when it isn't this year. Pure: it runs in
  Node too.
- `src/update-pill.js` and `src/update-pill.css` (exports `./update-pill`,
  `./update-pill.css`): the shared update pill, a see-through pill over the
  top bar that says a new version is available, with Reload and a dismiss.

      import { showUpdate } from "/kit/update-pill.js"; // and update-pill.css
      const pill = showUpdate({
        message: "A new version of Den is available.",
        reloadLabel: "Reload", dismissLabel: "Not now", cancelLabel: "Cancel",
        askFirst: () => (hasUnsavedText()
          ? { message: "You have unsaved text on this page. Reload anyway?" }
          : null),
        onReload: () => location.reload(),
        onDismiss: () => rememberDismissed(version),
      });
      pill.hide();

  No full-width strip: the pill's own fill is the surface at 20% with
  `blur(3px) saturate(1.4)`, so the bar shows through it, and the bar
  beside it stays clickable. When `askFirst` returns a message (unsaved
  text, say), Reload asks once and the × reads Cancel. A text past one line
  turns the pill into a card. Knobs, set on `.den-upd`: `--upd-pad-y`
  (default 8px) and `--upd-top` (default: a 50px pill centred on a 48px
  bar, top -1px; for a 56px bar,
  `calc(env(safe-area-inset-top, 0px) + 3px)`). It reads `--surface`,
  `--text`, `--muted`, `--border-strong`, `--accent`, `--accent-text` and
  `--upd-shadow`.

## The shell and its parts (0.6.0)

The global shell is the kit's: the top bar, the left rail with its pins,
collapse toggle and ☰ drawer, the version chip, What's new, the Report
button and form, and the update pill. A product gives its own parts as
data and HTML slots; it keeps no copy of the kit's markup, CSS or code.

- `src/shell-html.js` (export `./shell-html`): the markup, pure (no DOM),
  so it runs in Node and in the page. A product renders its frame on the
  server and in the browser with the same function.

      import { shellHtml } from "@monster-orange/den-ui/shell-html";
      const html = shellHtml({
        product: { name: "Acme", version: "2.0.0" },  // title?, href?
        nav: [{ id: "home", label: "Home", href: "/", group: "work",
                icon: "home", current: true }],      // badge, pin, lead, …
        groups: [{ id: "work", label: "Work" }],      // from? tags a group
        foot: [],                                     // under the spacer
        lang: "en",                                   // en, es or ja
        slots: { start, end, bell, account },         // the product's HTML
        collapsed: false,
        report: true,                                 // false: reports off
      });

  Also `topBarHtml`, `railHtml`, `navItemHtml`, `versionChipHtml`,
  `reportButtonHtml`, `icon(name)` (`src/icons.js`) and `esc`.

- **Slots.** The top bar reads: ☰, the brand, `start` (a search, a scope
  menu), then the right group: `end` (status chips), Report, `bell`, the
  version chip, `account`. Report · bell · account keep their place
  whatever a product puts in its slots.
- `src/shell-client.js` (export `./shell-client`): hydrates what
  shell-html drew. `hydrateShell(root, { lang, onCollapse, onUnpin,
inert, menuOpen })` binds the rail's keys (↑ ↓ Home End, Delete unpins),
  the collapse toggle and the ☰ drawer (a modal below 720px: the page
  inert, Escape or the scrim closes it), and returns `{ rove, paint(html,
force), setCollapsed, unpin, openDrawer, closeDrawer, drawerOpen,
syncPinToggles }`.
- `src/shell.css`, `src/whatsnew.css`, `src/report.css`: the look. Link
  them after `tokens.css`.
- `src/version.js` (the chip's label and its unread dot), `src/whatsnew.js`
  (the release notes pop-up: newest first, earlier versions on request,
  copy as Markdown or for chat), `src/report.js` and `src/report-shot.js`
  (the Report form, its screenshot and masks).

### The client entry: `src/kit.js` (`window.DenUI`)

    import DenUI from "/kit/kit.js";   // also sets window.DenUI
    DenUI.configure({ lang, product: { name }, adapter, report, whatsNew });
    DenUI.mount(root, model)          // shellHtml(model) into root, hydrated
    DenUI.hydrate(root, opts)         // a shell rendered on the server
    DenUI.version.set("v2.0.0"); DenUI.version.unread(true);
    DenUI.whatsNew.open();            // .close(), .load()
    DenUI.update.set({ version });    // the update pill; .hide()
    DenUI.report.open({ prefill });   // ⌘⇧F and any [data-den-report] too
    DenUI.busy.run(action, run, opts) // the working pop-up (busy.js)

### The adapter

The kit names no URL. Every call to the product goes through the adapter;
a missing call turns its feature off rather than failing.

| call                  | used by                          | returns                                       |
| --------------------- | -------------------------------- | --------------------------------------------- |
| `changelog()`         | What's new                       | `[{ version, date, sections }]`, newest first |
| `applyUpdate()`       | the update pill's Reload         | anything; the page reloads after              |
| `fileReport(payload)` | Report                           | `{ number, url }` or `{ error }`              |
| `request(id)`         | the working pop-up's Check again | `{ state, result?, error? }`                  |

With `fileReport`, Report ends on "Filed as #N" and a link to it. With no
way to send, Report offers "Copy report" only: the report as text, to
paste where the team tracks issues. A product with more (a preview, a
sign-in flow, drafts) gives `info`, `diagnostics`, `preview`, `send`,
`githubSend`, `githubPoll` and `saveDraft`; see the top of `report.js`.

### Strings

`src/strings.js` (export `./strings`) exports `en`, `es` and `ja`: every
word the kit shows, each key starting `kit.`, the same keys and
`{placeholders}` in all three (a test checks). `{product}` is the name
given to `configure`. A product adds its own words, or its own versions
of the kit's, with `DenUI.strings(lang, table)`; an unknown language falls
back to English.

### Content Security Policy

The shell, the version chip, What's new, the update pill, Report, the
working pop-up and the dialogs work under `script-src 'self'; style-src 'self'`: no
inline `style` attributes, no inline scripts, handlers or `<style>`, no
`eval`. They set custom properties through the CSSOM
(`style.setProperty`), which the policy allows. A browser test loads a
kit page under that policy and fails on any violation. Since 0.6.2 the
ask-and-tell dialogs (dialog.js) work under it too, and the test covers
them.

### The parity gate: `den-ui-parity`

    npx den-ui-parity [--root .] [--src src]... [--json]

It scans a product's source for its own copy of a kit component (markup
that draws the kit's elements, CSS for them, a function with a kit
builder's name, a file named as or identical to a kit file) and exits 1
when it finds one. Den runs it in CI (`npm run gate:den-ui`).

A product that keeps a copy on purpose names it in `DIVERGE.md` at its
repository root, one row per component, with a reason:

    | component | reason |
    |---|---|
    | report | our reports go to a ticket desk, not an issue tracker |

(or a list: `- report: our reports go to …`). The components are `shell`,
`version`, `whatsnew`, `update`, `report` and `working`. A row without a
reason does not count. With no DIVERGE.md, every copy fails.

## The working pop-up and types (0.6.1)

- `src/busy.js`, `src/busy-words.js` and `src/busy.css` (exports `./busy`,
  `./busy-words`, `./busy.css`): the working pop-up. Its look is
  `busy.css`, linked, never injected. Link it in the page's `<head>`;
  without that, busy.js links it from beside itself the first time it
  opens.

      busyAction("save", async (headers, progress) => {
        progress("Copying files");          // a line under the title
        const r = await fetch("/api/save", { method: "POST", headers });
        if (!r.ok) throw { status: r.status };
        return r.json();
      }, {
        // A failure trying again won't fix: its link in place of Try again.
        next: (err) => (err.status === 403
          ? { label: "Sign in", href: "/sign-in" } : null),
      });

  `next` is `{ label, href }` or a function of the failure that returns
  one (or null for Try again). The pop-up then says that trying again
  won't help, and the link is its primary button. `progress(text)` lines
  show in order while it works. `quietFail`, `inlineError`, `skipDone`
  and `extra` are as before, and a success still closes at once with a
  toast.

- Types: every `src/*.js` has a `.d.ts` beside it; the package's `types`
  is `src/kit.d.ts`. A test compiles a consumer against them with
  `--strict`.

## 0.6.3

- Report: ⌘↵ (Ctrl+Enter) is the form's primary button on Write and on
  Include, as in every pop-up: Write → Include → Review. Review still
  sends nothing until the person clicks.
- shell.css: the page's main (`#den-content`) takes what is left of the
  window under the top bar (`flex: 1 1 auto`), so a short page's last row
  can reach the window's bottom at every width.
- shell.css: the top bar is pinned. It is `position: fixed` at the top,
  as the rail under it is, and the body has `padding-top` of the bar's
  height (and `box-sizing: border-box`, so its 100vh minimum still holds).
  On a page whose body scrolls, or whose `html, body` are `height: 100%`,
  the bar stays put and no gap opens above the rail.
- `reportButtonHtml({ label, prefill })` (and `DenUI.report.button`): a
  row's own Report button. `label` replaces the word and names the button;
  `prefill` (`{ kind?, title?, description? }`) is kept on it as JSON
  (`data-den-report-prefill`), and the kit's click opens Report filled
  from it. `reportPrefillOf(el)` reads it back. With neither, the button
  is as before.

## 0.6.2

- `src/dialog.css` (export `./dialog.css`): the ask-and-tell dialogs'
  look, linked, never injected. Link it in the page's `<head>`. Without
  that, dialog.js links it from `configureDialog({ css })`, else from
  beside another kit stylesheet on the page.
- Report: `fileReport(payload)` gets `payload.shot`, the masked
  screenshot as a PNG data URL, or `null` when "Don't include" is picked.
- `busyAction`'s `next` takes `{ label }` with no `href`: the failure
  says those words in place of Try again, and Close is the primary.
- `shellHtml`'s `product.mark`: `{ text?, svg?, label }`, drawn in
  `.den-mark`. `text` is escaped. `svg` is the product's own markup, with
  the same trust as the icons. `label` names it (role="img"). With no
  mark, the slot is empty as before.
- `den-ui-parity` works through npx and `node_modules/.bin`: it compares
  real paths to know it was run as a command.

## Themes

A theme may override every colour in both modes, the shadow, the bar,
type, radius, radius-button, density and fonts. It never overrides
spacing, motion or layers, so layouts stay the same.

## Rules

- Components use tokens only: a test fails on a raw colour outside
  `tokens.css`.
- Every text and background pair passes WCAG AA in both modes (4.5:1 for
  text, 3:1 for marks); status pills are checked on their own tint, and
  the remote colour on its 16% disc.
- The fonts stay within 120 KB.

## Licence

MIT (`LICENSE`). The fonts are under the SIL Open Font License 1.1
(`src/fonts/OFL.txt`).
