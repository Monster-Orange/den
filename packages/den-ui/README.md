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

in the theme `NAV_THEME`, Den's default theme "den" 2.0.1 (the kit's
default tokens). A host must run the inventory on that image, in that
theme, with the shipped references, so both products are measured in one
browser build and one look. Start the image's run-server and connect both
browsers to it through `DEN_PW_WS`:

    docker run -d --init --platform linux/amd64 -p 127.0.0.1:3921:3921 \
      mcr.microsoft.com/playwright:v1.61.1-noble@sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6 \
      npx -y playwright@1.61.1 run-server --port 3921 --host 0.0.0.0
    DEN_PW_WS=ws://localhost:3921/

    import { chromium } from "playwright";   // 1.61.1, as the image
    import { collectNav, compareNav, formatNavDiffs, NAV_BROWSER_IMAGE,
      NAV_THEME } from "@monster-orange/den-ui/inventory";
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
    const diffs = compareNav(
      await collectNav(page, { image: NAV_BROWSER_IMAGE, theme: NAV_THEME }),
      ref,
      { hostSlots: ["#my-status"] },   // what the host fills itself
    );
    expect(formatNavDiffs(diffs)).toBe("");   // one line per difference

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
  it (`crumb-sep`), the brand's title (`brand-title`), the search's
  placeholder (`search-ph`), each rail group (`rail-group`), its heading
  (`group`) and its pages (`page`), and the account entry's words
  (`account-name`). The search's name is the host's too
  (`data-nav-name="host"`: its name is not compared). Their count, keys, ids, text and
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
- **Search field**: `searchHtml({ placeholder, label?, id?, shortcut? })`,
  for the `start` slot. It is the placeholder with ⌘K inside the field. A
  click, Enter, ⌘K or Ctrl-K calls `onActivate(via)` (`"click"` or
  `"key"`) and fires `den-ui:search` on the field. The kit owns no
  palette.
- **Bell**: `bellButtonHtml({ count, label? })`, for the `bell` slot. It is
  a button with a count badge (99+ past 99, none at 0) and
  `aria-haspopup="dialog"`. Its name says the count. The panel is a dialog
  on `<body>`: a heading, then the host's `items` as rows (`{ text, href?,
time?, read? }`) or the empty state. `bellPanelHtml(...)` takes `actions`
  (buttons beside the heading), `lead`, `body` (the host's own rows),
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
  work as before.
- **Mark layout**: `.den-mark` (a centred flex box, its image a block)
  and the text and raster forms are in `shell.css`. A host deletes its
  own copy.
- **A phone's tap targets**: below 480px every top-bar button is at least
  32px each way (`shell.css`).
- **The brand on a phone**: below 480px the brand (its mark alone) never
  shrinks; the host's chips give way.
- **Search name**: `searchHtml({ label })` names the field; by default
  the kit's "Search" (en, es, ja), not the placeholder.
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

## Licence

MIT (`LICENSE`). The fonts are under the SIL Open Font License 1.1
(`src/fonts/OFL.txt`).
