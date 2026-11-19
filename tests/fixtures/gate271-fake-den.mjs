// A fake bed for gate/271.mjs (tests/unit/test-infra/gate-271-runner.test.ts):
// Settings' Hub project row over a fake Den, no browser. The row offers
// "Create a Hub project named <name>" first. `words`: "good" (en, es and
// ja), "english" (English in es and ja) or "keys" (the catalog key where es
// or ja has no words). `state`: the picker's state ("unlinked" or
// "offline"). Invented names only.
const NAME = "sample-app";
const WORDS = {
  en: {
    label: "Hub project",
    first: `Create a Hub project named ${NAME}`,
    button: "Create",
  },
  es: {
    label: "Proyecto de Hub",
    first: `Crear un proyecto de Hub llamado ${NAME}`,
    button: "Crear",
  },
  ja: {
    label: "Hub のプロジェクト",
    first: `Hub プロジェクト「${NAME}」を作成`,
    button: "作成",
  },
};

export function fakeBed({ words = "good", state = "unlinked" } = {}) {
  const settings = { language: "en" };
  let lang = "en";
  const wordsIn = () => {
    if (lang === "en" || words === "good") return WORDS[lang];
    if (words === "english") return WORDS.en;
    return {
      label: "set.workspace.hub",
      first: "hubp.createOpt",
      button: "hubp.create",
    };
  };
  const page = {
    locator() {
      return {
        async waitFor() {},
        async scrollIntoViewIfNeeded() {},
      };
    },
    async waitForSelector() {},
    async evaluate(fn) {
      const src = String(fn);
      const w = wordsIn();
      if (src.includes("documentElement.lang"))
        return {
          html: lang,
          label: w.label,
          first: w.first,
          name: NAME,
          button: w.button,
        };
      if (src.includes("data-hubp-state"))
        return {
          row: true,
          state,
          firstValue: state === "offline" ? null : "__create",
          firstText: state === "offline" ? null : w.first,
          inputValue: state === "offline" ? null : NAME,
          inputEditable: state !== "offline",
        };
      throw new Error(`fake page: no evaluate for ${src.slice(0, 60)}`);
    },
  };
  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto() {
      lang = settings.language || "en";
    },
    async api(p, init) {
      const body = (b, status = 200) => ({
        ...b,
        ok: status < 300,
        status,
        json: async () => b,
      });
      if (p !== "/api/settings") return body({}, 404);
      if (init?.method === "POST") {
        const b = JSON.parse(init.body);
        if ("language" in b) settings.language = b.language ?? "en";
      }
      return body({ ...settings });
    },
    async shot() {},
  };
  return { ctx, language: () => settings.language };
}
