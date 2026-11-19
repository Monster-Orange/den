// A fake bed for gate/160.mjs (tests/unit/test-infra/gate-160-runner.test.ts):
// Settings' approval-policy rows over a fake Den, no browser. ctx.api
// answers as the bed's does (the JSON body's fields, with ok, status and
// json()). `words`: "good" (en, es and ja), "english" (English in es and
// ja) or "keys" (empty words where es or ja has none). Invented names only.

const ROWS = {
  en: {
    "agents.approvals_policy": {
      label: "Agent writes",
      desc: "What an agent may do without your Allow.",
      options: ["Run, no note", "Run and tell me", "Ask me"],
    },
    "agents.approvals_watch": {
      label: "Watched",
      desc: "Things you watch: an agent's write on one asks.",
      options: [],
    },
    "agents.approvals_critical": {
      label: "Always ask",
      desc: "Writes that always ask.",
      options: [],
    },
  },
  es: {
    "agents.approvals_policy": {
      label: "Escrituras de agentes",
      desc: "Lo que un agente puede hacer sin tu permiso.",
      options: ["Ejecutar sin aviso", "Ejecutar y avisarme", "Preguntarme"],
    },
    "agents.approvals_watch": {
      label: "Vigilado",
      desc: "Lo que vigilas: una escritura sobre ello pregunta.",
      options: [],
    },
    "agents.approvals_critical": {
      label: "Preguntar siempre",
      desc: "Escrituras que siempre preguntan.",
      options: [],
    },
  },
  ja: {
    "agents.approvals_policy": {
      label: "エージェントの書き込み",
      desc: "許可なしでエージェントができること。",
      options: ["通知なしで実行", "実行して知らせる", "確認する"],
    },
    "agents.approvals_watch": {
      label: "ウォッチ",
      desc: "ウォッチ中のものへの書き込みは確認します。",
      options: [],
    },
    "agents.approvals_critical": {
      label: "常に確認",
      desc: "常に確認する書き込み。",
      options: [],
    },
  },
};
const IDS = [
  "agents.approvals_policy",
  "agents.approvals_watch",
  "agents.approvals_critical",
  "workspace.approvals_policy",
  "workspace.approvals_watch",
  "workspace.approvals_critical",
];

export function fakeBed({ words = "good" } = {}) {
  const settings = {
    language: "en",
    approvals_policy: null,
    approvals_watch: [],
    approvals_critical: [],
  };
  let lang = "en";
  const rowsIn = () => {
    if (lang === "en" || words === "good") return ROWS[lang];
    if (words === "english") return ROWS.en;
    return Object.fromEntries(
      Object.keys(ROWS.en).map((id) => [
        id,
        { label: "", desc: "", options: ["", "", ""] },
      ]),
    );
  };
  const body = (b, status = 200) => ({
    ...b,
    ok: status >= 200 && status < 300,
    status,
    json: async () => b,
  });
  const page = {
    async waitForSelector() {},
    locator() {
      return {
        async scrollIntoViewIfNeeded() {},
        async count() {
          return 1;
        },
      };
    },
    async evaluate(fn, ids) {
      const src = String(fn);
      if (src.includes("documentElement.lang")) {
        const r = rowsIn();
        return {
          html: lang,
          rows: Object.fromEntries(ids.map((id) => [id, r[id] ?? null])),
        };
      }
      if (src.includes("seg button"))
        return Object.fromEntries(
          ids.map((id) => [
            id,
            {
              options: id.endsWith("policy")
                ? ["auto", "notify", "ask"].concat(
                    id.startsWith("workspace") ? ["install"] : [],
                  )
                : [],
              input: !id.endsWith("policy"),
            },
          ]),
        );
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
      if (p !== "/api/settings") return body({ ok: false }, 404);
      if (init?.method === "POST") {
        const b = JSON.parse(init.body);
        if ("language" in b) settings.language = b.language ?? "en";
      }
      return body({ ...settings });
    },
    async fetch() {
      return {
        status: 403,
        headers: {},
        body: { error: "only a person can change approvals_policy" },
      };
    },
    async shot() {},
  };
  return { ctx, language: () => settings.language, ids: IDS };
}
