// A fake bed for gate/415.mjs (tests/unit/test-infra/gate-415-runner.test.ts):
// a Playwright-like page over a fake Den's Report form, no browser.
// Options:
//   targets: [{ repo, visibility, real, unknown }]: what GET /api/report
//            gives (visibility), what GitHub says without a token (real:
//            "public" | "not-public"), and whether Den's visibility cache
//            holds no answer for it (unknown);
//   pill:    "follows" (the pill and note follow the selected repo) or
//            "stuck" (they stay as first drawn, the bug clause 5 names);
//   words:   "good" (en, es and ja), "english" (English in es and ja) or
//            "keys" (the catalog key where es or ja has no text);
//   cache:   false: the bed has no visibility cache file.
// Also `fetch`: a stand-in for GitHub's API (no network). Invented names.

const WORDS = {
  en: {
    pub: "Public repository",
    priv: "Private repository",
    pubW: "Screenshots and text are visible to everyone.",
    privN: "Only people with access to this repository can see it.",
  },
  es: {
    pub: "Repositorio público",
    priv: "Repositorio privado",
    pubW: "Las capturas y el texto son visibles para todos.",
    privN: "Solo quienes tienen acceso a este repositorio pueden verlo.",
  },
  ja: {
    pub: "公開リポジトリ",
    priv: "非公開リポジトリ",
    pubW: "スクリーンショットとテキストは誰でも見られます。",
    privN: "このリポジトリにアクセスできる人だけが見られます。",
  },
};

export function fakeBed({
  targets = [{ repo: "acme/engine", visibility: "public", real: "public" }],
  pill = "follows",
  words = "good",
  cache = true,
} = {}) {
  const settings = { language: "en" };
  let lang = "en";
  let open = false;
  let step = null;
  let selected = targets[0]?.repo ?? null;
  let drawn = selected; // what the pill was drawn for
  const sent = [];
  const say = (k) =>
    words === "english" || lang === "en"
      ? WORDS.en[k]
      : words === "keys"
        ? `kit.report.${k}`
        : WORDS[lang][k];

  const view = () => {
    const t = targets.find((x) => x.repo === drawn) ?? {};
    const v =
      t.visibility === "private" || t.visibility === "internal"
        ? t.visibility
        : "public";
    return {
      html: lang,
      pill: say(v === "public" ? "pub" : "priv"),
      vis: v,
      warn: v === "public" ? 1 : 0,
      note: v === "public" ? 0 : 1,
      warnText: v === "public" ? `${say("pub")}. ${say("pubW")}` : "",
      noteText: v === "public" ? "" : say("privN"),
    };
  };

  const loc = (sel) => ({
    first() {
      return this;
    },
    locator: (inner) => loc(`${sel} ${inner}`),
    async click() {
      if (sel === "[data-den-report]") {
        open = true;
        step = "write";
      } else if (sel.endsWith('[data-act="next"]')) step = "where";
      else if (sel.endsWith('[data-act="review"]')) step = "review";
      else if (sel.endsWith('[data-act="discard"]')) {
        open = false;
        step = null;
      } else if (sel.endsWith('[data-act="send"]')) sent.push(selected);
    },
    async fill() {},
    async count() {
      return sel.endsWith('select[data-f="repo"]') && targets.length > 1
        ? 1
        : 0;
    },
    async selectOption(repo) {
      selected = repo;
      if (pill === "follows") drawn = repo;
    },
  });

  const page = {
    async goto() {
      lang = settings.language || "en";
      open = false;
      step = null;
      selected = targets[0]?.repo ?? null;
      drawn = selected;
    },
    locator: loc,
    keyboard: {
      async press(k) {
        if (k === "Escape" && open) step = "discard?";
      },
    },
    async waitForFunction() {
      if (step !== "review") throw new Error("not at review");
    },
    async waitForTimeout() {},
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes("fb-dlg")) return view();
      throw new Error(`fake page: no evaluate for ${src.slice(0, 60)}`);
    },
  };

  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async api(p, init) {
      if (p === "/api/report")
        return res(200, {
          ok: true,
          enabled: true,
          repos: targets.map((t) => ({
            repo: t.repo,
            visibility: t.visibility,
          })),
          github: { signedIn: true },
        });
      if (p === "/api/settings") {
        if (init?.method === "POST") {
          const b = JSON.parse(init.body);
          if ("language" in b) settings.language = b.language ?? "en";
        }
        return res(200, { ...settings });
      }
      return res(404, null);
    },
    async readBed(rel) {
      if (!cache || rel !== "report-visibility.json") return null;
      return JSON.stringify(
        Object.fromEntries(
          targets.map((t) => [
            t.repo,
            { v: t.unknown ? null : t.visibility, at: 1 },
          ]),
        ),
      );
    },
    async shot() {},
  };
  /** GitHub's API without a token, for the gate's own look (no network). */
  const fetch = async (url) => {
    const repo = String(url).replace("https://api.github.com/repos/", "");
    const t = targets.find((x) => x.repo === repo);
    if (!t || t.real !== "public") return res(404, null);
    return res(200, { private: false });
  };
  return { ctx, fetch, sent, language: () => settings.language };
}
