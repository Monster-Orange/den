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

- **Kind tags (0.7.3).** A pin or a link into another product sets
  `kind` on its nav item: `"project"`, `"den"`, `"service"`, `"hub"`, or
  `{ artifact: "Mock" }` (an artifact pin's own word, in the host's
  language). The kit draws a small uppercase tag at the row's end in the
  scope labels' look, and the tooltip and name are always the kit's:
  "North · Project"; a label that is its kind word reads once ("Hub").
  A badge says what it counts with `what` (`"open"`, `"waiting"`,
  `"down"`, `"running"`) and the kit words it: "North · Den, 3 waiting".
  Hosts pass data, never display text: a `tip`, `title` or `aria-label`
  on an entry with a kind is not used. Any other kind is dropped: the tag
  never names a machine. A project pin may set `icon: { initial: "North" }`
  for its initial in a disc. A pin row gets `aria-keyshortcuts="Delete"`
  from the kit. The nav inventory records each entry's kind and
  `compareNav` reports a `kind` difference. Host text in any rail entry
  (`title`, `aria-label`, `aria-labelledby` or `aria-description` in
  `attrs`, or a badge's `label`) is stamped `data-nav-host-text`:
  `navWarnings` lists it and `compareNav` fails on it (`hostText`).
  `data-*` attrs stay allowed.

- **Off entries (0.7.4).** An entry that can't be opened sets `off` to
  why, as data: `"connect"` (not connected yet), `"reconnect"` (its
  sign-in is no longer accepted), `"forbidden"` (not allowed; an admin
  decides), `"unreachable"` (can't be reached right now) or `"config"`
  (its settings have a problem). The kit greys the entry (`.den-off`)
  and words why, in en, es and ja, after the name in the tooltip and
  the accessible name: "Acme Co · Hub, reconnect in Settings"; an entry
  without a kind reads "Docs, can't be reached right now". Any other
  value is dropped (not greyed, no words). The nav inventory records
  each entry's `off` and `compareNav` reports an `off` difference.

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
syncPinToggles, folds }`.
- Rail sections fold (0.15.0, issue 1444). `railHtml({ …, folded })`
  draws each listed section (group id) `data-folded`, never the one
  holding the current page; its entries sit in `div.den-gb#den-gb-<id>`
  and its heading stays the plain `div.den-gh`, so with no script every
  entry shows. `hydrateRailFolds(root, { store, lang, onChange })` (run
  by `hydrateShell`; `folds: false` turns it off, `folds: store` gives
  the store) makes each heading the toggle: the whole row a button with
  `aria-expanded` and `aria-controls`, named "Hide {section}" / "Show
  {section}" (en, es, ja), with the folded entries' summed count
  (`.den-bdg`, `.bad` when one is) and a chevron turned -90° when folded.
  A click, Enter or Space folds it. The store is `{ get(), set(ids) }`;
  the default, `railFoldStore()`, keeps the ids in localStorage
  (`den.rail.folded`) and reads any failure as all open. Clicks are taken
  on the rail, so a repaint keeps them; call `apply()` after one.
  Since 0.18.0, a folded section hides only once `hydrateRailFolds` has
  marked its root `data-folds`: a script that failed to load or threw
  leaves every entry showing. Past 99 the name is "Show {section}, 99+
  inside" (`kit.rail.unfoldMany`).
- `src/shell.css`, `src/whatsnew.css`, `src/report.css`: the look. Link
  them after `tokens.css`.
- `src/version.js` (the chip's label and its unread dot), `src/whatsnew.js`
  (the release notes pop-up: newest first, earlier versions on request,
  copy as Markdown or for chat), `src/report.js` and `src/report-shot.js`
  (the Report form, its screenshot and masks).
- Issue 793: What's new is drawn by the dialog frame (`dialogHtml`, kind
  "panel", and `mountDialog` from `dialog.js`), so serve `dialog.js` and
  `dialog.css` wherever `whatsnew.js` is served; `whatsnew.css` styles only
  the notes inside it. `base.css` gives `body` and every `dialog` the kit's
  sans (`var(--sans, …)` with the kit's own list after it), so nothing a
  script puts in `body` falls back to the browser's serif.
  `focusWhenFree(el)` (`dialog.js`) focuses a page's own field now, or
  when the open kit pop-up over it closes.
- Issue 864: one pop-up at a time, both ways. What's new waits behind a
  pop-up already open, and a kit question (`askConfirm`, `askText`,
  `tell`) asked while What's new is open makes it step aside: it isn't
  counted as seen, and it opens again once the question is answered.
  `onAsk(fn)` in `dialog.js` is how a pop-up hears of each question.

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
    DenUI.saveState(el, { save, copyText, watch }) // save-state line

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

Each of `info()`'s `repos` may say its `visibility` (`"public"`,
`"private"` or `"internal"`) and an `audience` (who can see it, as words).
A public repo, or one that doesn't say, gets the "Public repository" pill
and the "visible to everyone" warning above Send. A private or internal
one gets its own pill, the audience, and a quiet line instead of the
warning. Both follow the repo chosen in Review.

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
`version`, `whatsnew`, `update`, `report` and `working`, and since 0.7.0
`scope`, `search`, `bell`, `appearance` and `account`. A row without a
reason does not count. With no DIVERGE.md, every copy fails.

### Nav inventory

`inventory/nav-inventory.js` (export `./inventory`, types beside it): one
spec every product runs, so two products' top bars and rails never
quietly differ. It lists the global nav element by element and compares
it with the kit's reference: Den's nav as signed off, in
`inventory/reference/den-<browser>-<width>.json` (export
`./inventory/reference/*`), for `chromium` and `webkit` at `1280` and
`390`.

One browser build and one theme. The references were taken on
Playwright's image `NAV_BROWSER_IMAGE`, its linux/amd64 build (the arm64
build ships another Chromium; on an arm64 machine add
`--platform linux/amd64`):

    mcr.microsoft.com/playwright:v1.61.1-noble@sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6

(only for this check: Den's other browser tests run on the host's own
build, `npm run pw:server` in Den's repo) in the theme `NAV_THEME`, Den's default theme "den" 2.0.1 (the kit's
default tokens). A host must run the inventory on that image, in that
theme, with the shipped references, so both products are measured in one
browser build and one look. Start the image's run-server and connect both
browsers to it through `DEN_PW_WS`:

    docker run -d --init --platform linux/amd64 -p 127.0.0.1:3921:3921 \
      mcr.microsoft.com/playwright:v1.61.1-noble@sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6 \
      npx -y playwright@1.61.1 run-server --port 3921 --host 0.0.0.0
    DEN_PW_WS=ws://localhost:3921/

    import { chromium } from "playwright";   // 1.61.1, as the image
    import { collectNav, compareNav, formatNavDiffs, navWarnings,
      NAV_BROWSER_IMAGE, NAV_THEME } from "@monster-orange/den-ui/inventory";
    import { readFileSync } from "node:fs";
    import { createRequire } from "node:module";

    // exposeNetwork: the browser in the container reaches the host's own
    // server on this machine's loopback through the connection.
    const browser = await chromium.connect(process.env.DEN_PW_WS,
      { exposeNetwork: "<loopback>" });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 },
      colorScheme: "light" });
    await page.goto("http://localhost:<port>/");   // the host's own page
    const ref = JSON.parse(readFileSync(createRequire(import.meta.url)
      .resolve("@monster-orange/den-ui/inventory/reference/den-chromium-1280.json"),
      "utf-8"));
    const snap = await collectNav(page, { image: NAV_BROWSER_IMAGE,
      theme: NAV_THEME });
    const diffs = compareNav(
      snap,
      ref,
      { hostSlots: ["#my-status"] },   // what the host fills itself
    );
    expect(formatNavDiffs(diffs)).toBe("");   // one line per difference
    // 0.7.1: host HTML where the kit's account or search should be.
    // Listed, not failed, until 0.7.2 gives every slot a data path.
    for (const w of navWarnings(snap)) console.warn(w);

Pass `theme` as the theme the page really draws in (Den reads it from
`/api/themes`). On another browser build (a different fingerprint: user
agent and the measured width of one fixed line in each face the nav
uses) the one difference is `env`, "reference taken on X, running on Y";
in another theme it is `theme`. Boxes that can't match are never
compared.

- `collectNav(page, { image, theme })` returns `{ version, viewport,
env, elements, tokens }`. `env`: `userAgent`, `faces` (the
  fingerprint), `image`, `theme`. `elements`: `header.den-top`,
  `nav.den-rail` and every element under them with a box, in DOM order
  (hidden ones and an `<svg>`'s shapes left out). Each has `key`,
  `parent`, `slot` (`top`, `rail`, or `foot`: after the rail's spacer),
  `role`, `tag`, `name` (aria-label, aria-labelledby, alt, its text for a
  control or a leaf, title), `classes`, `box` `{ x, y, w, h }` and
  `style`: display, visibility, height, the four corner radii,
  background-color, each side's border width, style and colour,
  font-size, -weight, -family, -style, line-height, letter-spacing,
  text-transform, padding, row-gap, column-gap, color, opacity,
  box-shadow. A key is `#id`, `[data-nav="x"]`, or the parent's key `>`
  tag.class (`[n]` among like siblings): `#den-search > kbd`.
- `compareNav(actual, reference, { hostSlots, themeTokens, tolerance })`
  returns `[{ key, slot, property, reference, actual }]`, empty when the
  navs match. It fails on an element missing, extra or out of order
  (`property` `element`, `order`); a role, tag, name or class list that
  differs; a box edge moved more than `tolerance` px (default 2:
  `box.left`, …); any computed style that differs (`style.font-weight`),
  colours and fonts included.
- `hostSlots`: keys (`#den-status`) or one class (`.den-scope`) whose
  element and everything under it are the host's own: not compared, on
  either side. A host slot wider or narrower than the reference (or on
  one side only) may move or stretch its neighbours sideways by exactly
  that much, never by anything else.
- Host content: the kit stamps `data-nav-role` on what each host fills
  with its own words: each scope crumb (`crumb`) and the separator after
  it (`crumb-sep`), the brand's title (`brand-title`), each rail group
  (`rail-group`), its heading (`group`) and its pages (`page`), and the
  account entry's words (`account-name`). An element with
  `data-nav-name="host"` holds a name that is the host's (not compared).
  The search's placeholder and name are the kit's, and compared. Their count, keys, ids, text and
  width are never compared, on either side. The first of each role is
  compared with the other side's first, and what it holds by key, on
  every computed style and on height. Their size may move what follows by
  exactly its change: sideways in the bar (their contents' width, not a
  filled box's), down in the rail (heights; the rail's spacer shrinks by
  as much). The mark, the search field's box and all other chrome stay
  strict. The references hold each element's `host`.
- `themeTokens`: empty by default, and never set on a parity run: both
  products run in `NAV_THEME`, so any colour or font that differs is a
  real gap. It is only for a run that switches themes on purpose. What a
  theme may change, and so what the list may name: the colour tokens
  (`--bg`, `--surface`, `--raised`, `--sunken`, `--text`, `--muted`,
  `--faint`, `--border`, `--border-strong`, `--accent`, and the rest of
  tokens.css's colours) and the font tokens (`--sans`, `--mono`,
  `--display`). A colour or font-family listed may differ when, on both
  sides, it comes from that token. How a value's token is found: every
  custom property declared on `:root` or `html` (in any sheet the page
  can read, inside `@media` and `@layer` too) is read from `<html>`'s
  computed style; a colour is set on a probe element's `color`, a family
  list on its `font-family`, and read back, so it is in the form computed
  values take. `snapshot.tokens` maps each colour and family seen to the
  tokens that compute to it.
- Fonts: `await pinNavFonts(context)` (from `./inventory`) pins the
  system faces a nav names to the kit's own Rubik and Space Mono, so text
  lays out alike from run to run, as when the reference was taken. Call it
  on the Playwright `BrowserContext` before opening the page. It puts the
  pin stylesheet first on every page and serves `/__pin-fonts/*` from the
  package's `src/fonts` (or `{ fontsDir }`). It finds them from its own
  files, never from the working folder: the package's `imports` entry
  `#den-ui-fonts-dir` is `inventory/fonts-dir.mjs` for an ES module
  (`import.meta.url`) and `inventory/fonts-dir.cjs` for CommonJS
  (`__dirname`). Both ship in `inventory/`; a host serves neither.
- Font families in the fingerprint are one line each (`navFamily`: every
  run of whitespace one space, trimmed), so a token written over several
  lines names the same face as one written on one.
- The user agent: under `@playwright/test`, the config's device
  `userAgent` leaks into the contexts of a browser you connect to, and the
  environment check then sees another user agent than the reference's.
  Set `test.use({ userAgent: "" })`, or create the context with no
  `userAgent`. `NAV_BROWSER_IMAGE` and
  `NAV_THEME` are exported beside it.

Den runs it in `tests/unit/den-ui/nav-inventory.browser.test.ts` (CI's
`den-ui-nav` job starts the image) with red cases that must fail: the
search field 3 px over, its corners, the bell gone, two elements
swapped, a font weight, the search's ⌘K and icon gone, a theme token's
colour, a font-family; a host slot's new contents must pass.
`nav-inventory.test.ts` checks the comparer with no browser. To take the
reference again, on purpose only: `DEN_UI_NAV_CAPTURE=1` with the
browser test, on the image (Den's real server on the demo distribution,
`/settings`).

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

## A button that waits shows pulsing dots (issue 699)

Every button the kit holds shows three pulsing dots in place of its
label at once, until the server answers: busyAction's `opts.button`,
`pending()`'s button, and a plain POST form's submitter. The button keeps
its size (the label stays, hidden, and stays its accessible name), is
`aria-disabled="true"` with `aria-busy="true"`, and keeps its own colours.
It is never `disabled` (issue 1434): it keeps the keyboard's focus, and a
click, Enter or Space on it while held does nothing. The kit stops the
`click` at the window, in the capture phase, when busy.js loads: a capture
listener on window added before that still runs first, and `pointerdown`,
`mousedown` and `keydown` still reach the page. Act on `click`, not on
those, or check `aria-busy` yourself.

Issue 1054: for one request, that is all. No Working pop-up opens, and
the dots stay until the answer. The Working pop-up is only for an
action that names its steps: `steps: true` in `registerActions`,
`opts.steps` on the call, or a run that calls `progress(text)`. Reconnect
mode keeps it too. It opens after `dotsMs` (default 3000), with the dots
behind it. With no answer by `NO_ANSWER_MS` (60 s), the no-answer pop-up
opens (Check again). A failure opens the failure pop-up.

    import { pending, watchForms, configureBusy } from "@monster-orange/den-ui/busy";

    // A fetch-driven button: dots until the answer. A Response that
    // isn't ok, or no answer, is the failure pop-up with Try again.
    button.addEventListener("click", () =>
      pending(button, (headers) =>
        fetch("/api/save", { method: "POST", headers }),
      ),
    );

    // Plain POST forms: one listener; the submitter shows dots until the
    // next page comes.
    watchForms();

    // The wait before an action with steps shows its pop-up (default 3000 ms).
    configureBusy({ dotsMs: 3000 });

- The button never shows an error itself. A failure before the pop-up
  gives the label back, and the error goes where it goes today (the
  caller for an `inline` action, else the failure pop-up). After the
  pop-up, the pop-up shows it; Try again holds the button again; Close
  gives the label back.
- A button that never waits opts out with a reason:
  `data-instant="opens a menu"`. An empty reason doesn't count;
  `instantProblems(html)` lists each one (a kit test runs it over the
  kit and its first product's pages).
- A wait that says its own words and isn't one request through
  `busyAction` (a stream's output, a form with its own error line) holds
  its button with the dots alone: `holdDots(button)`, then
  `holdDots(button, false)` to give the label back. No pop-up opens.
  `heldCount()` says how many buttons are held now (a number only): a
  page that lets each go on its answer leaves 0.
- `opts.dots: false` on busyAction holds a button the old way (no dots,
  the pop-up at `OPEN_MS`).
- The look is in `src/busy.css`, under "issue 699: the held button"
  (`.bz-lbl`, `.bz-dots`, `@keyframes bz-dot`). Reduced motion: still
  dots.

## The Markdown editor (0.7.5)

`src/markdown-editor.js` and `src/markdown-editor.css` (exports
`./markdown-editor`, `./markdown-editor.css`): a Markdown field,
ported from an existing editor. CodeMirror 6 on the Markdown text: the
document is the string that is stored, character for character, and the
live preview is drawn in place, as decoration only (no preview pane,
never converted to HTML and back).

    import { mountMarkdownEditor } from "@monster-orange/den-ui/markdown-editor";
    // link markdown-editor.css after tokens.css
    const ed = mountMarkdownEditor(el, {
      value: "", onChange: (text) => save(text),
      label: "Notes",          // or labelledBy; describedBy for help
      mode: "full",            // "full": a toolbar, Enter is a new line,
                               // ⌘/Ctrl+Enter submits; "lite": a chat box,
                               // Enter sends, Shift+Enter is a new line
      onSubmit, onEscape, onBlur, placeholder, maxLength, rows,
      disabled, readOnly, required, invalid, lang, uiLang, nonce,
    });
    await ed.ready;            // CodeMirror has taken over
    ed.setValue(""); ed.focus(); ed.run("bold");
    ed.insertBlock(text); ed.insertLinkTo(label, url); ed.replaceEnd(n, text);
    ed.update({ disabled: true }); ed.destroy();

- **Lazy.** The module imports no CodeMirror. On mount it loads
  `@codemirror/state`, `view`, `commands` and `@lezer/markdown` with
  `import()`, so a bundler puts them in a chunk of their own, and a plain
  textarea takes the typing until it arrives (its toolbar works too). The
  editor then goes on from the textarea's text, focus, caret and
  selection. `loadMarkdownEditor()` warms the chunk early. The packages
  are the kit's `dependencies`, pinned exactly. Den's own pages don't
  load it.
- **The preview.** On a line the caret is not on, the markers hide and
  the words show formatted; `- ` becomes a bullet. On the line being
  edited every marker stays, muted. CommonMark without setext headings,
  indented code, HTML, entities, reference links, images and autolinks,
  plus strikethrough; only an http(s) link is drawn as a link.
- **IME.** An Enter that belongs to a composition (`view.composing`,
  `isComposing`, keyCode 229, or within 100 ms of `compositionend`, as
  Safari sends it) never sends, submits or adds a line. The preview is
  frozen while a composition is open, and `maxLength` never cuts one.
- **Shortcuts.** ⌘/Ctrl+B, I, E (code), K (link), ⇧X (strike); Enter in
  a list or quote continues it, and on an empty item ends it.
- **Words.** The toolbar's are `kit.md.*` in strings.js (en, es, ja), in
  `uiLang`, else `<html lang>`.
- **Touch sizes.** On `(pointer: coarse)` or below 720px the toolbar's
  buttons are `--tap` (44×44px) and the text is 16px (no zoom on focus);
  elsewhere 28px and 15px.
- **CSP.** CodeMirror writes its base styles into a `<style>`: under a
  strict `style-src`, pass the page's `nonce`.
- The content element has `data-md-dirty` while it holds unsaved text
  (for an update pill's `askFirst`).

## The save-state line (`den-savestate`)

- `src/savestate.js`, `src/savestate.css` (exports `./savestate`,
  `./savestate.css`): what an autosaving editor says about its text. It
  works with any input, textarea or editor; the host gives the save.

      const line = createSaveState(document.querySelector("#save-line"), {
        save: () => api.saveDraft(field.value),   // rejects on failure
        copyText: () => `${title.value}\n\n${field.value}`,
        watch: field,     // input → changed(), focusout → flush()
      });
      // line.changed(), line.flush(), line.retry(), line.state(), line.destroy()

- The element becomes `<p class="den-savestate">` with `role="status"`,
  `aria-live="off"` and `data-state` (`idle`, `saving`, `saved`,
  `error`): a 6 px dot, then the words, 13 px on a 20 px line (idle is
  empty and keeps its height).
- It saves 800 ms after the last change, and at once on blur and when the
  page goes hidden. "Saving…" shows only when a save takes more than
  400 ms; "Saved" (title "Saved at {time}", from `time.js`) stays until the
  next save. A failure shows "Not saved. Retrying…" with Copy text (what
  `copyText()` returns), retries at 2 s, 4 s and 8 s, then every 30 s, and
  at once when the browser is back online.
- A visually hidden polite region beside the line says only the error and
  its recovery; `aria-live="off"` keeps the routine "Saved" quiet.
- Only the dot's colour moves, over `--dur-fast`; none under reduced
  motion. Its words are `kit.savestate.*` in `strings.js` (en, es, ja).
- `saveScheduler({ save, onChange })` is the same timing with no DOM.
- Link `savestate.css` in the page's `<head>`. Without that, savestate.js
  links it from `opts.css`, else from beside another kit stylesheet on the
  page.

## The popover

- `src/popover.js`, `src/popover.css` (exports `./popover`,
  `./popover.css`): a small non-modal box anchored to what opened it (a
  button, a link, or a node in an SVG map), for a card or a short set of
  actions. The host gives it its content and its name; the kit places it
  and owns its keys and focus.

      import { openPopover } from "@monster-orange/den-ui/popover";
      // link popover.css after tokens.css
      const pop = openPopover(node, {
        content: cardEl,          // a Node, or HTML the host has escaped
        label: "Item card",       // or labelledBy: an id inside it
        onClose: () => {},
      });
      pop.close();                // focus goes back to the anchor

- It is `role="dialog"` and never `aria-modal`, so there is no focus trap
  (only the kit's modal dialogs trap focus). Focus moves to its first
  control. Esc, a press outside it, or Tab out of it closes it. Esc and a
  press on nothing put focus back on the anchor; a press on a control
  leaves focus there. Tab past its last control goes on to what follows
  the anchor, and Shift+Tab before its first goes back to the anchor.
- A press on the open anchor closes it, and that press's click never
  reaches the anchor, so a host that opens it on click doesn't open it
  again, and a link anchor doesn't follow its `href`.
- A button anchor (an HTML button, or anything with `role="button"`, an
  SVG node too) says `aria-haspopup="dialog"`, and `aria-expanded` and
  `aria-controls` while it is open. One is open at a time.
- It sits below the anchor, or above it when there is no room, always 8px
  inside the viewport, and moves with scroll and resize. Its look is the
  menus' (`.den-pop`): `--raised`, `--border-strong`, `--shadow`, 10px
  corners, in every theme. For a phone-width sheet, use the dialog
  instead.

## The panel fold toggle, its edge strip and the switch

- `src/panel-fold.js`, `src/panel-fold.css` (exports `./panel-fold`,
  `./panel-fold.css`): a side panel that folds away so the main column
  reads clean (issues 548 and 549). The host keeps the state (shown or
  folded, remembered or not) and lays its page out; the kit draws the two
  controls and owns their words, keys and focus.

      import { foldToggleHtml, edgeStripHtml, hydrateFoldToggle,
        hydrateEdgeStrip } from "@monster-orange/den-ui/panel-fold";
      // link panel-fold.css after tokens.css
      bar.innerHTML = foldToggleHtml({ pressed: true, controls: "side", lang });
      slot.innerHTML = edgeStripHtml({ count: 2, controls: "side", lang });
      const fold = hydrateFoldToggle(bar.querySelector(".den-fold"), {
        onToggle: (next) => layout(next ? "panel" : "folded"),
      });
      const strip = hydrateEdgeStrip(slot.querySelector(".den-strip"), {
        onShow: () => { layout("panel"); fold.set(true); },
      });
      fold.set(kept === "panel");   // the host's own change: no call
      strip.setCount(3);

- **The toggle** is a `<button class="den-fold">` with an icon and the
  kit's word ("Panel"), `aria-pressed` (pressed: the panel shows) and
  `aria-controls` when given. A press (click, Enter, Space) moves
  `aria-pressed` and calls `onToggle(next)`; focus stays on it. 32px tall;
  44px on a phone or a touch screen.
- **The strip** goes where the folded panel was: 40px wide, a
  `role="complementary"` region named "Panel, hidden", a "Show panel" icon
  button (32px, a 44×44px tap on a phone or a touch screen) and the count
  under it (none at 0, 99+ past 99). The count is seen as a number and
  heard as the kit's badge words: `what` is `"open"` (default),
  `"waiting"`, `"down"` or `"running"`. Show panel calls `onShow()`; when
  the host then hides the strip and leaves focus there, focus goes to the
  fold toggle for the same panel (else to the panel, when it takes
  focus). A focus the host moved itself is kept.
- Hosts pass data, never words: a `label`, `title` or `aria-label` given to
  either builder is not used. Words: `kit.fold.panel`, `kit.fold.show`,
  `kit.fold.hidden` and `kit.badge.*`, in en, es and ja. Show or hide each
  with the `hidden` attribute.
- `src/preview.js`, `src/preview-frame.js` (exports `./preview`,
  `./preview-frame`): a page or a component as a preview (issue 789),
  in a frame that is `sandbox="allow-scripts"` (an opaque origin: the
  previewed page's scripts can't reach the host's DOM, cookies or
  storage), at a width (Hub's frames are 390, 768 and 1440; it scales
  down to fit, never up) and a theme. The width, theme and mode change
  with no reload. `kitBase` is where the kit is served (`/kit/` in Den,
  `/static/den-ui/` in Hub). The frame's CSP lets only the kit's own files
  load (from `origin` + `kitBase`; `origin` defaults to the host page's)
  and blocks every network call and form post, so a previewed page can't
  call out or load from another site. Its own inline scripts and styles
  still run. The opaque origin keeps the host's cookies out only while
  they are `SameSite=Lax` or `Strict`, as Den's are.

      import { mountPreview } from "@monster-orange/den-ui/preview";
      const pv = mountPreview(el, { html, width: 1440, theme: "sketch" });
      pv.setWidth(390); pv.setTheme(null, "dark"); pv.destroy();

- `src/themes/sketch.css` (export `./themes/sketch.css`): the sketch
  theme's tokens (issue 788: greys, dashed edges, outline buttons, one
  face), built from `src/themes/sketch/den-theme.json`. Link it after
  `tokens.css`.
- `src/switch.js`, `src/switch.css` (exports `./switch`, `./switch.css`):
  a labelled on/off control (issue 551).

      import { switchHtml, hydrateSwitch } from "@monster-orange/den-ui/switch";
      row.innerHTML = switchHtml({ label: "Show notes in the text",
        help: "Kept on this device.", on: true, disabled: false, id: "notes" });
      const sw = hydrateSwitch(row.querySelector(".den-switch"), {
        onChange: (on) => save(on),
      });
      sw.set(false); sw.setDisabled(true); sw.on(); sw.destroy();

- `<label class="den-switch">` holds the label, the help under it, then an
  `<input type="checkbox" role="switch">` named by the label alone
  (`aria-labelledby`) and described by the help (`aria-describedby`). The
  label and help are the host's own words, the name of its own setting,
  as a page's name in the rail is; the switch adds no words of its own (a
  screen reader says on and off). No label: nothing is drawn. No `id`: one
  of the kit's (`den-sw-N`). A click on the row, Space or Enter calls
  `onChange(on)`; disabled is out of the tab order and calls nothing.
- The row is 44px tall. The track is `--accent-fill` on and
  `--border-strong` off (`--border` when disabled); the knob is
  `--surface` and slides over `--dur-fast`, not at all under reduced
  motion. A transparent border shows the track in forced colours.
- Under `style-src 'self'`: no inline styles, nothing injected.
- `src/tabs.js`, `src/tabs.css` (exports `./tabs`, `./tabs.css`): tabs,
  the segmented control (DS component #1): one row of two to six choices,
  exactly one chosen.

      import { tabsHtml, hydrateTabs } from "@monster-orange/den-ui/tabs";
      box.innerHTML = tabsHtml({ kind: "switch", label: "Tier",
        items: [{ id: "p", text: "Primitive colours", count: 92 },
                { id: "all", text: "All" }], chosen: "all", size: "auto" });
      const tabs = hydrateTabs(box.querySelector(".den-tabs"), {
        onChange: (id) => show(id),
      });
      tabs.set("p"); tabs.chosen(); tabs.destroy();

- The model: `kind` (`"page"`, `"switch"` or `"panel"`), `label` (the
  group's name), `items` (each `{ id, text, href, count, disabled,
panel }`: `id` names it, `text` is its words, `href` its page, `count`
  a number after it, `disabled` greys it, `panel` the id of the panel it
  shows), `chosen` (the chosen item's `id`) and `size` (`"auto"`, `"m"`
  or `"l"`).
- `kind: "page"` is a `<nav>` of links, the chosen one
  `aria-current="page"`, each its own Tab stop, working with no script.
  `kind: "switch"` is a `role="group"` of buttons, the chosen one
  `aria-pressed="true"`: one Tab stop, ← and → move and choose, Home and
  End go to the ends. `kind: "panel"` is a `role="tablist"`: each tab has
  `aria-selected` and `aria-controls` its `panel` (the host's element,
  which becomes a `role="tabpanel"` shown only while its tab is chosen),
  with the same keys, and Tab goes on into the panel. With no script each
  panel tab is a link, its `href` or `?tab=<id>`. The `label` names the group, and each item's
  `text` is the host's own words; the kit adds none. A `count` follows
  the label and is read with it. A `disabled` item is faint and read out,
  but can't be chosen. No label, or fewer than two items: nothing is drawn.
- It never wraps and never breaks a label. When the segments don't fit
  the width the block is given, it folds into one native `<select>` with
  the same choices (counts in brackets) after the visible label, and goes
  back once they fit again, a few px later so it doesn't flicker. It is
  measured with a ResizeObserver, not a breakpoint. With no script it
  doesn't fold. Folded page tabs follow the chosen link, unless
  `onChange` returns false.
- 36px tall, or 44px (`--tap`) at 600px wide or less or with a coarse
  pointer (`size: "auto"`; `"m"` and `"l"` fix it). Each segment is at
  least 72px wide. The chosen one is `--accent-fill` with `--on-accent`
  words; hover is `--sunken`; the focus ring is 2px `--accent` outside
  the segment. `data-den-force="hover"` or `"focus"` on a segment shows
  that state without the pointer or keys, for a page of its states.
  Tokens only; under `style-src 'self'`, nothing injected.

## A list's filter bar and bulk bar

Two parts for a list of things (issues 552 and 553). Both are data-only:
the host passes its facets, counts, choices, actions and callbacks; the
kit draws the markup and owns every word, in en, es and ja. A facet's,
an option's and an action's label are the host's own words, given as data
(as a rail page's label is); the kit never takes a host's words for its
own parts or names.

- `src/filter-bar.js`, `src/filter-bar.css` (exports `./filter-bar`,
  `./filter-bar.css`): one "Filters (n)" button that opens a panel of
  facets, and what is chosen as chips under the row, each with ×, then
  Clear all.

      import { mountFilterBar } from "@monster-orange/den-ui/filter-bar";
      // link filter-bar.css after tokens.css
      const bar = mountFilterBar(el, {
        id: "docs-filter",
        facets: [{ id: "status", label: "Status",
                   options: [{ value: "draft", label: "Draft", count: 2 }] }],
        selected: { status: ["draft"] },
        onChange: (selected, change) => applyFilter(selected),
        start: findBox,              // the host's nodes before Filters
        end: [sortButton, addButton],// and after it, in the same row
      });
      bar.update({ facets });        // new counts; focus stays put

  `change` is `{ facet, value, on }` (an option or a chip),
  `{ clear: facetId }` (a facet's Clear) or `{ clear: null }` (Clear
  all). Each option shows its count; one with 0 can't be chosen unless it is chosen.
  Filters is a disclosure (`aria-expanded`, `aria-controls`); the panel
  is a group named "Filters", a group per facet, its options toggle
  buttons (`aria-pressed`). Esc in the panel closes it, focus on Filters.
  Removing a chip focuses the next chip, else the one before, else
  Filters; Clear all focuses Filters; a facet's Clear its first option.
  Under 720px the start node takes its own line and the chips scroll in
  their own row; there, and on `(pointer: coarse)`, every control is
  `--tap` (44px) tall. `filterBarHtml(data)` draws it in Node.

- `src/bulk-bar.js`, `src/bulk-bar.css` (exports `./bulk-bar`,
  `./bulk-bar.css`): "{n} selected", Clear, and the host's actions with
  their counts ("Pause 3"), sticky at the bottom of the list.

      import { mountBulkBar } from "@monster-orange/den-ui/bulk-bar";
      const bulk = mountBulkBar(el, {
        count: 3,
        actions: [{ id: "pause", label: "Pause", count: 3 },
                  { id: "move", label: "Move", count: 3, disabled: true }],
        onAction: (id, button) =>      // a host's own dialog: the button
          askConfirm({ title, message, opener: button }), // gets focus back
        onClear: () => unselectAll(),
        returnFocus: () => selectAllBox,
      });
      bulk.update({ count: 0 });       // hidden at 0

  `el` becomes the bar,
  `<div class="den-bulk" role="region" aria-label="3 selected">`; a
  visually hidden polite region beside it says the count when it
  changes and "Selection cleared" after Clear. A disabled action never
  reaches the host. Clear hides the bar at once and focus goes to
  `returnFocus`. It sticks 12px over the bottom of the scrolling list
  (and over the safe area). Under 720px each action takes the bar's
  width; there, and on a touch screen, every button is 44px tall.
  `bulkBarHtml(data)` draws it in Node.

- `DenUI.filterBar(el, opts)` and `DenUI.bulkBar(el, opts)` mount them
  in the kit's language. Den serves the four files at `/kit/`.
- The words are `kit.filter.*` and `kit.bulk.*` in `strings.js`. Both
  work under `script-src 'self'; style-src 'self'`.

## The general button, the page action menu and the settings row

Three pieces, data in, the kit's words out (en, es, ja).

- **The general button** (issue 556): `src/button.css` and `src/button.js`
  (exports `./button.css`, `./button`). `.den-btn` for any page, inside the
  frame or not: secondary is the base, `.primary` the accent fill,
  `.danger` a step that takes something away (red words), `.sm` the small
  size; a link drawn as a button is `a.den-btn`. Its words and an icon sit
  in a row, 6px apart. A visible focus ring, and a 44px tap on a touch
  screen (its box unchanged). These are the values Den's frame drew and
  the second product's shipped button (issue 673). It is the one button:
  the kit's dialogs and the working pop-up draw `.den-btn` too, and
  `den-ui-parity` counts a product's own `.btn` as a copy. A page that
  links `dialog.css` (or `busy.css`) must link `button.css` beside it:
  `.dk-btn` sets only the size, so without it the dialog's buttons have
  no look. Neither imports it, so it is asked for by one URL (issue 231).

      buttonHtml({ label, variant: "primary", size: "sm", href?, type?,
                   disabled?, id?, attrs: { "data-…": …, "aria-…": … } })

  A disabled link has no href and `aria-disabled`. Any other variant,
  size or attribute is dropped.

- **The page action menu** (issue 555), in `shell-html.js` and
  `shell-client.js` (its look in `shell.css`, More in `button.css`):

      btnBox.innerHTML = pageMenuButtonHtml({ id: "doc-more", lang });
      hydratePageMenu(document.getElementById("doc-more"), {
        items: [                          // or () => items, each opening
          { id: "edit", label: "Edit", href: "/doc/edit" },
          { id: "copy", label: { key: "app.copy" }, onSelect: copyLink },
          { hr: true },
          { id: "dl", label: "Download", disabled: true,
            note: "Downloads are off.", noteHref: "/settings#downloads" },
        ],
        onSelect: (id, item) => {},       // an item with no onSelect
        lang,
      });

  "More ▾" is the kit's word. A label or note is the host's words, or
  `{ key, vars }` in the kit's tables (add yours with `addStrings`). A
  disabled item has `aria-disabled`, is faint, does nothing (the menu
  stays open), and is described by its note, right under it: a row to
  follow when it has `noteHref`, else a line. Keys, focus back and a press
  outside are ◐ ▾'s. Below 720px (or on touch) More and each row are 44px.
  `menuRowHtml(row)` is now exported: the row builder the kit's own menus
  use (◐ ▾ and the account menu draw exactly what they drew before); it
  takes `disabled`, `describedBy`, `id` and `cls` too.

- **The settings on/off row** (issue 554): `src/setting-row.js` and
  `src/setting-row.css` (exports `./setting-row`, `./setting-row.css`).
  Link them with `button.css` and `savestate.css`.

      const row = mountSettingRow(el, {
        id: "downloads", label: "Owners can download", help: "…",
        checked: true, who: ["Admins", "Owners"],   // [] is nobody
        last: { by: "@sam", at: "2026-11-18T10:40:00Z" },  // null: none yet
        readOnly: false, lang,
        onSave: (checked) => api.save(checked),     // rejects on failure
      });
      row.set("saved"); row.checked(); row.destroy();

  A checkbox and its label, the help line, Save, the save state and the
  line "Admins and Owners can change this · Last changed 2 minutes ago by
  @sam". Save calls `onSave` with the box's state: "Saving…" past 400 ms,
  then "Saved", or "Not saved. Try again."; Save is busy
  (`aria-disabled`) meanwhile and keeps focus; a change to the box clears
  "Saved". The state line wears `savestate.css`'s look and is a polite
  status. `settingRowHtml(o)` draws it in Node, and
  `hydrateSettingRow(el, { onSave })` wires it. With `form` (`action`, and
  `csrf`, `field`, `method` if needed) it is a form that posts with no
  script. `readOnly` disables the box
  and Save. The words are `kit.setrow.*` and `kit.savestate.*`.

- `DenUI.buttonHtml`, `DenUI.pageMenu(btn, opts)` and
  `DenUI.settingRow(el, opts)` are the same, in the kit's language.

- **The text-field settings row** (issue 584): `src/setting-field.js` and
  `src/setting-field.css` (exports `./setting-field`,
  `./setting-field.css`). Link them with `button.css`.

      const row = mountSettingField(el, {
        id: "folders", label: "Folders it may read",
        help: "One folder per line.", placeholder: "~/notes",
        value: ["~/notes", "~/code"], multiline: true, lang,
        // save: { verb: "save" } by default, or the host's own words
        onSave: (value, lines) => api.save(lines),  // resolves to the saved value
      });
      row.value(); row.error("Not a folder: ~/x"); row.destroy();

  A label, a single-line input or a multi-line box, help text, Save, and
  an error line under the box. The host's words are its own text or
  `{ key, vars }` (a key it added with `addStrings`). Save is disabled
  until the value changes, and runs through the working pop-up
  (`busy.js`'s `pending`; pass `busy` to use another). Done, the row shows
  the value as saved and Save is disabled again; refused, the error line
  says "Not saved. Try again." and typing clears it.
  `settingFieldHtml(o)` draws it in Node, `hydrateSettingField(el, opts)`
  wires it, and `DenUI.settingField(el, opts)` is the same in the kit's
  language.

- **Shared button verbs** (issue 584): `kit.verb.save`, `kit.verb.cancel`,
  `kit.verb.delete`, `kit.verb.close` and `kit.verb.tryAgain`, in en, es
  and ja. A host uses `kitT(lang, "kit.verb.save")` instead of its own.

## 0.7.1

The top bar's search sits in the same place in every product (issue 303).

- **The account is data.** `accountHtml` and `accountMenuHtml` take
  `{ name?, login, role? }`. The rail's entry is the name over `@login`,
  or `@login` alone when no name is known; never the role. The account
  menu's header is the same, then the role on its own line. The kit adds the `@`. The old `{ label, detail }`
  (and the menu's `{ name, detail }`) still work for this release, drawn
  as given, and the nav inventory fails a host that uses them
  (`legacy`). `accountWho(a)` gives the lines and the shape.
- **The search never moves.** Its x is a function of the viewport only:
  `searchSlot(width)` gives `{ x, w }` (464 / 304 at 1280, 396 at 1100,
  256 at 960, 82 / 54 on a phone), the same in any host. The left part is
  the smaller of `--den-top-left` (444px) and what the search and the
  right group's reserve (`--den-top-right`, 380px) leave.
  Under 944px the search gives way first (issue 981): the left part keeps
  `--den-top-left-min` (220px), so the project picker is never under the
  search, and the search narrows down to its icon
  (`--den-top-search-min`, 56px; 240 / 128 at 768).
- **The right group is anchored from the right edge.** ◐ at the bar's
  padding, then the version in a fixed slot (`--den-top-version` 96px;
  `--den-top-version-md` 64px up to 1100px; its text ends in "…", the
  whole version in its title), the bell and Report, 4px apart: the same
  x in any host. Report, the bell and ◐ never shrink; the kit sets their
  font and box. The host's chips (`div.den-end`, always drawn, empty
  without chips) take the room left: a chip gives way down to its dot
  and "…", and the kit puts its whole words in its title and name (a
  name or title the host set itself is kept).
- **Crumbs.** A crumb's label gives way first, then its value ends in
  "…"; before the last crumb a value keeps about 4ch and its ▾.
- **Checks.** `topSlotDiffs(snap)` checks the search's slot and the
  right group's places at any width (no reference needed); `compareNav`
  runs it too, and fails a crumb whose label shows while its value is
  hidden.
- **Shape, not only style.** The inventory compares what a kit slot
  draws: the account entry's shape is one of the kit's (`name,login` on
  two lines, `login` or `local` on one: `ACCOUNT_SHAPES`), the old fields
  fail (`legacy`), and the search's box is pinned. `navWarnings(snap)` lists host HTML where the kit's account
  or search should be: a warning in 0.7.1, a failure in 0.7.2.
- **A page with no rail** (issue 694). `topBarHtml({ rail: false })`
  draws the same bar without ☰ and without `aria-controls` for the rail;
  `shellHtml({ rail: false })` draws no rail either. The header is stamped
  `data-nav-shape="no-rail"` (`TOP_SHAPES`). `railShapeDiffs(snap)`, run
  by `compareNav`, fails a top bar shape the kit doesn't draw, and a
  no-rail page that holds ☰ or a rail, drawn or hidden.

- **Three parts.** The bar is a grid: the left part (`div.den-left`: ☰,
  the brand, and what `start` holds before the search, the crumbs), the
  search, then the chips (the host's `end` in `div.den-end`, then Report,
  the bell, the version and ◐ ▾, pinned to the right edge). The kit finds
  its search in `start` and puts it in its slot; a host's markup is
  unchanged.
- **Settings** (custom properties on `.den-top`, with their defaults):
  `--den-top-left` (444px), `--den-top-search` (304px),
  `--den-top-left-min` (220px), `--den-top-search-min` (56px), and under 720px
  `--den-top-left-md`
  (200px) and, under 480px, `--den-top-left-sm` (62px: ☰ and the mark).
  At 1280px the search is at x 464, 304 wide; on a phone at x 82.
- **Giving way.** Long words never move the search. The crumbs give way
  first: each crumb gets an equal share until it is whole, so a short one
  keeps its words and a long one ends in "…"; the last crumb is kept
  whole. Then the install name ends in "…". Under about 1100px the
  host's chips give way (their words end in "…"; the kit's buttons keep
  their size). The chips' column is never narrower than the kit's own
  buttons, so the chips never run under the search: when the bar is too
  narrow for all three parts, the left part gives way and the search
  moves left. A host chip is width 0 growing to its own width
  (`max-width: max-content`): put its words in its last child, a span,
  which ends in "…".
- **A gap after ⌕**: 8px between the search and the chips, and 8px more
  before the first chip.
- **The search's words** are the kit's by default ("Search…", named
  "Search"; es, ja). A host may set the placeholder with
  `searchHtml({ placeholder })`: one word in the page's language, or words
  per locale (`{ en, es, ja }`). The name (its aria-label) follows what it
  shows (label in name): the kit's "Search", or the host's placeholder
  without a trailing "…" ("Find work…" is named "Find work"). It takes no
  label.
- **Touch** (`pointer: coarse`): every control in the bar takes a 44×44px
  tap (an `::after` hit area, centred; the look is the same), and the
  key hints (⌘K, ⌘⇧F, any `.den-kbd`) hide.
- **`.den-hit`**: the same 44×44px tap for a host's own buttons and tabs.
  On a touch screen it is `position: relative` plus a transparent,
  centred `::after` at least 44×44px; without touch it does nothing. Its
  look and layout never change. It sits beside `.den-kbd`, the one
  key-cap rule, which hides on a touch screen wherever it is (a palette,
  a button). `den-ui-parity` knows both: a host keeps no copy.
- **Nav inventory**: the search, Report, the bell, the version chip and ◐
  ▾ (`PINNED_CLASSES`) are compared at the reference's x and width: no
  host-content shift excuses moving them. Den's references, and the
  parity fixture and PNGs, were re-taken for this layout.

## 0.7.0

No new file. One import changes, for hosts that serve a fixed list of kit files:

`shell-client.js` now imports `dialog.js` (and `shell-html.js`): serve `dialog.js` wherever `shell-client.js` is served.

Default tokens are Den's theme. `tokens.css`'s defaults are now the values
of Den's own theme (`themes/den/den-theme.json`): its type stacks (sans,
mono, display, ja), its shape (radius 8px, radius-button 6px) and both
modes' colours, shadow and bar. A host on the kit's defaults looks like
Den. Light and dark switch as before. Themes are still token sets the host
lists in `appearanceMenuHtml({ themes })`; the kit ships no theme files.
Tokens the theme has no value for keep the kit's own: `--info`,
`--violet`, `--upd-shadow`, `--density` and the rest.

`tokens.css` owns `--den-pop-shadow`, the shadow of a pop-up or a picker
dialog: `0 16px 40px rgb(0 0 0 / 0.25)` in light, `/ 0.6` in dark. A host
that kept its own copy of that token can delete it.

The whole global nav is the kit's. Pieces of the top bar and the rail
that a host drew itself move into the kit, so every host draws them the
same way, with the same CSS values. In order: ☰ · brand · scope crumbs ·
search with ⌘K · the host's `end` slot (status chips) · Report · bell ·
version chip with its pip and the update-waiting pill · ◐ ▾. The rail's
foot: the host's entries · Settings · account · Collapse. The host gives words,
values and callbacks. The kit draws the markup and owns focus and keys.
Each piece is optional: one left out draws nothing.

- **Scope crumbs**: `scopeHtml({ crumbs, label?, after? })`, for the
  `start` slot. Each crumb is `{ key, label, value, menu?, id?, title?,
hidden?, optional? }`. `label` is the small-caps word (COMPANY,
  PROJECT, ENV). With a `menu`, the crumb is a ▾ button. Without one, it is
  a plain label. `menu` is a list of links `[{ label, href, current? }]`
  or HTML, and the kit draws and opens it below the ▾. Enter, Space, ↓ and
  ↑ open it, and ↑ ↓ Home End move in it. Esc closes it and goes back to
  the ▾. `menu: true` means the host opens its own menu: `onOpen(key,
button)`. A crumb left out of the list draws nothing, and no separator
  either (a host with no ENV, say). `scopeCrumbHtml(crumb)` draws one crumb.
  A kit-drawn list of more than 6 links gets a filter field at its top
  (`filter`: a number sets that threshold, `false` turns it off). The menu
  opens on the field. Typing hides the links that don't hold the text, and
  "No match" shows when none do. ↓ goes to the links, Enter takes the first
  one shown, and Esc clears the text, then closes the menu.
- **Search field**: `searchHtml({ id?, shortcut?, placeholder? })`, for
  the `start` slot. It is the kit's placeholder ("Search…"), or the
  host's, with ⌘K inside the field. A
  click, Enter, ⌘K or Ctrl-K calls `onActivate(via)` (`"click"` or
  `"key"`) and fires `den-ui:search` on the field. The kit owns no
  palette.
- **Bell**: `bellButtonHtml({ count, label? })`, for the `bell` slot. It is
  a button with a count badge (99+ past 99, none at 0) and
  `aria-haspopup="dialog"`. Its name says the count. The panel is a dialog
  on `<body>`: a heading, then the host's `items` as rows (`{ text, href?,
time?, read? }`) or the empty state. `bellPanelHtml(...)` takes `actions`
  (buttons beside the heading), `lead`, `body` (the host's own rows),
  `sections` (issue 101: `{ needs, earlier? }`, the rows of each; the kit
  heads them "Needs you", always first, and "Earlier", in its own words),
  `empty`, `after` and `foot`. A click on the bell toggles the panel.
  Opening it focuses its first link or button. Esc closes it and focus goes
  back to the bell, in Safari too (`focusBack` from `dialog.js`). A click
  outside closes it. `onEscape(e)` returning true keeps it open (the
  host's own question inside it, say). `shell.bell.setCount(n)` updates the
  badge.
- **Account entry**: `account: { label, detail?, href? | menu? | action? }`
  on `shellHtml` or `railHtml` puts it last in the rail's foot, before the
  collapse toggle. It reads "label · detail". It is a link, or with
  `action: true` a button that calls `onAction`. `accountHtml(...)` draws
  it alone.
- **Account menu**: with `menu: true`, the entry is a button (id
  `den-account`) that opens a menu: who is signed in, where, a rule, then
  the entries. Wire it with `hydrate`'s `account: { menu, onPick?,
onSubmit? }`. `menu()` gives `{ name, detail?, items }`. An item is a link
  `{ label, href }`, a button `{ label, id }` (`onPick("item", id)`), or a
  form post `{ label, action: { method?, url, csrf?, field? } }`. A form
  post needs no script: Sign out posts to `url`, with `csrf` in a hidden
  field (named `field`, `csrf` by default). `onSubmit(event, form)` runs
  first, and `preventDefault` there stops the post. The kit owns open,
  close, the keys, Esc and focus going back to the entry.
  `accountMenuHtml(...)` draws the content alone.
- **Appearance menu**: `appearanceButtonHtml({ label?, title? })`, for the
  `account` slot (last in the bar): ◐ ▾ with `aria-haspopup="menu"`. Wire
  it with `hydrate`'s `appearance: { menu, onPick }`. `menu()` gives, each
  time it opens, `{ mode, modes?, themes, notice?, languages, items }`:
  the mode (System, Dark, Light by default), the themes `{ value, label,
selected }`, a line under them, the languages `{ id, name, current }`,
  each named in itself, and entries after a rule (`{ label, href? | id }`).
  A pick calls `onPick(kind, value)` with `"mode"`, `"theme"`,
  `"language"` or `"item"`, and closes the menu. Click, Enter, Space, ↓ or
  ↑ open it on the checked entry. ↑ ↓ Home End move. Esc or Tab closes it
  and focus goes back to ◐ ▾, in Safari too. A press outside closes it.
  The host saves and applies the pick. The kit owns no settings.
- **Version pip and update-waiting pill**: the chip's pip (`#v-pip`) shows
  unread notes (`DenUI.version.unread(on)`, as before).
  `DenUI.version.waiting({ label, action, title?, name?, onClick })` shows
  the update-waiting pill right after the chip ("⚠ label · action", a
  pulsing warn pill; only ⚠ below 720px). `waiting(null)` hides it.
  `waitingHtml(...)` draws it.
- **Settings**: `settings: { href, label?, current? }` on `shellHtml` or
  `railHtml` puts Settings in the rail's foot after the host's entries and
  before the account entry. `settingsHtml(...)` draws it alone.
- **Brand mark**: `product.mark: { src, label }` draws an image file the
  way Den draws its theme's mark: `span.den-mark.den-mark-svg#den-mark`
  titled `label`, holding `<img src alt="" width="18" height="18">`. The
  kit ships the default theme's mark as `src/marks/den.svg`, beside
  `src/fonts/`; a host serves it with the kit's other files and passes
  `mark: { src: "<served path>/marks/den.svg", label }` (Den serves it at
  `/kit/marks/den.svg`). An image runs no script. `markHtml(mark)` draws
  it alone; Den's own theme mark is drawn by it. `{ text }` and `{ svg }`
  work as before. Issue 644: the mark has two drawings of one design.
  `marks/den.svg` is for 22px and up. `marks/den-16.svg` is drawn for
  16-18px: at the kit's 18px brand pass `marks/den-16.svg` (Den serves it
  at `/kit/marks/den-16.svg`). Both are exported (`./marks/*`).
- **Mark edge in dark mode**: in dark mode (`data-mode="dark"`, or the
  system's dark with no mode set) a mark gets a 1px cream edge
  (`--den-mark-edge`, `shell.css`) so its dark tile keeps its outline on a
  dark bar. Never in light. One mark file serves both modes.
- **Tab icons and the head snippet** (issue 644): `src/site/` holds one
  head snippet, `site/head.html` (the favicon as .ico and .svg, the touch
  icon, the manifest link and `<meta name="theme-color">`), and every file
  it names: `favicon.ico`, `favicon.svg`, `apple-touch-icon.png`,
  `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` and
  `site.webmanifest`. Exported as `./site/*`
  (`@monster-orange/den-ui/site/head.html`). A host puts the snippet in
  every page's `<head>` as it is, and serves each other file in the folder
  at the root (`/favicon.ico`, `/site.webmanifest`, …) with its type
  (`image/x-icon`, `image/svg+xml`, `image/png`,
  `application/manifest+json`). It may fill the manifest's `name`,
  `short_name` and `start_url` with its own. Den does all of this, so Den
  and every other product on the kit emit the same tags.
- **Mark layout**: `.den-mark` (a centred flex box, its image a block)
  and the text and raster forms are in `shell.css`. A host deletes its
  own copy.
- **A phone's tap targets**: below 480px every top-bar button is at least
  32px each way (`shell.css`).
- **The brand on a phone**: below 480px the brand (its mark alone) never
  shrinks; the host's chips give way.
- **Search words**: the placeholder ("Search…") and the field's name
  ("Search") are the kit's, in en, es and ja. A host can't set them: one
  search in every product.
- **Filtered menus**: a menu with the filter field is a pop-up holding the
  field, then the `role="menu"` list (`.den-mlist`, id `<menu>-list`),
  then "No match": a menu owns only its items. The field has
  `aria-controls` on the list and its `aria-label` ("Filter <label>").
  `attachMenuFilter(menu)` moves a host menu's rows, role and name into
  that list; `menu` keeps its id and stays the pop-up. The keys and the
  look are as before.
- **Key caps**: `.den-kbd` is the one key-cap rule: the search's ⌘K,
  Report's ⌘⇧F and any `<kbd class="den-kbd">` a host draws (its palette's
  hints, say). A 1px border with a 2px bottom, 4px corners, `--surface`
  behind, 5px each side. A host deletes its own copy.
- **Group headings**: a heading with its "from" tag is as tall as one
  without (32px in Den's fonts): the tag sits on a 12px line, centred.
- The kit's menus (◐ ▾, a crumb's own menu) wear `.den-pop`, `.den-mi`,
  `.den-ml`, `.den-hr` and `.den-mnote`, styled in `shell.css`.
- Wiring: `DenUI.hydrate(root, { scope, search, bell, account, appearance })` (or
  `mount`'s `model.hydrate`) wires each piece it finds. The shell it
  returns has `.scope`, `.search`, `.bell` and `.appearance`. For a host's own wiring,
  use `hydrateScope`, `hydrateSearch`, `hydrateBell`, `hydrateAccount`,
  `hydrateAppearance` and `setWaiting` in `shell-client.js`.
- A bell row opens on a click anywhere on it (its time, its dot, the
  space around), as its link does; its own buttons and fields stay
  theirs, and a row with no link does nothing (issue 420). The same
  behaviour for a host's own list: `wireRowOpens(root, rowSelector)` in
  `shell-client.js` (it returns a function that unwires it).
- The words: `kit.scope`, `kit.search.ph`, `kit.bell`, `kit.bell.n`,
  `kit.bell.empty`, `kit.settings`, `kit.appearance`,
  `kit.appearance.title`, `kit.mode.system`, `kit.mode.dark`,
  `kit.mode.light`, `kit.theme` and `kit.language`, in en, es and ja. The look is in `shell.css`. At 860px
  the crumbs' keys and any `optional` crumb give way. At 720px the crumbs
  hide and the search is only its icon.
- `den-ui-parity` knows them as components `scope`, `search`, `bell`,
  `appearance` and `account`, and the update-waiting pill as part of
  `version`. A product's own copy of one fails the gate. A product's
  own rows inside the bell, or its own menu inside a crumb, are not copies.
- Report's screenshot shows what the person sees (issue 295): the
  window's scroll and every scrolled pane's, with sticky and fixed parts
  where they are on screen. The image is still the window's size, so
  masks line up as before.

## 0.6.6

- A time drawn by `upgradeTimes` reads in the language of the part of
  the page it sits in: the nearest `[lang]` around the `<time>` first,
  then `<html lang>`, then the browser's. Text and title both. A row
  still in English on a translated page no longer reads "connected 今".
- No new files: hosts serving a fixed list change nothing.

## 0.6.5

- Focus goes back to what opened a pop-up when it closes, in Safari too.
  Safari doesn't focus a button on a click, so the browser's own dialog
  restore went to the page's body. Report, `askConfirm`, `askText`,
  `tell` and What's new now remember their opener and focus it again on
  every way out (Esc, Discard, Cancel, Close, after a send), without
  scrolling, when it is still on the page.
- The opener is `opts.opener` when given (`report.open({ opener })`,
  `askConfirm({ opener })`), else the focused element, else the control
  just pressed. A kit Report button is its own opener.
- The shared helper is in `dialog.js` (`openerOf`, `focusBack`), a file
  hosts already serve: no new kit file. The working pop-up already
  focuses its own `button` again; it is unchanged.

## 0.6.4

- shell.css: the top bar is its own layer from the start
  (`will-change: transform`). The update pill's glass (`blur(3px)
saturate(1.4)`, unchanged) made Chromium draw the page's text grayscale
  while the pill showed, so the bar's mark and name changed pixels when
  the pill appeared. Now the bar is the same with the pill shown or
  hidden. Its text is drawn as on any layer of its own (grayscale), as a
  sticky bar's always was.
- Inside the bar, a `position: fixed` element is placed against the bar,
  not the window: put pop-ups, palettes and toasts on `<body>`. A slot's
  `position: absolute` menu still drops below the bar (the bar never
  clips).

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

## Report opens at once (0.17.0, issue 1499)

`openReport()` shows the form as soon as it's picked, and no longer waits
for the screenshot. The capture starts before the form is on the page, and
leaves the form and everything inside it out. The first step says "Taking
the screenshot…" (`kit.report.shotWait`), and the shot fills in when it's
ready, without taking the focus or the words being typed. A shot that fails
shows the no-screenshot words, as before.

A report can go before the shot is there. It then goes without one, and
Review says so (`kit.report.shotLate`). A shot only goes once the person has
seen it on the first step, where they black out anything private.

## Licence

MIT (`LICENSE`). The fonts are under the SIL Open Font License 1.1
(`src/fonts/OFL.txt`).
