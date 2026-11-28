import { beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { DEN_ROLES } from "../../../src/shared/agents/roles.js";

type Table = Record<string, string>;
type Job = { value: string; label: string; help: string };
type Row = {
  id: string;
  control: {
    type: string;
    render: (host: unknown, ctx: unknown, io?: unknown) => void;
  };
};
type Registry = {
  DEN_SETTINGS: Row[];
  issueWriteJobs: (reg: unknown) => Job[];
  issueWriteRoles: (v: unknown) => string[];
  issueWriteSave: (ticked: string[], saved: string[], jobs: Job[]) => string[];
};

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
const ROW_ID = "agents.issue_writes";

function catalogs(): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch (e) {
      void e;
    }
  }
  return window.denMessages as Record<string, Table>;
}

const looked: [string, string][] = [];
const shellStub = () => ({
  denShell: {
    t: (k: string) => k,
    lang: () => "en",
    tr: (k: string, en: string) => {
      looked.push([k, en]);
      return en;
    },
  },
});

async function freshRegistry(): Promise<Registry> {
  let m: Registry | null = null;
  await jest.isolateModulesAsync(async () => {
    m =
      (await import("../../../src/ui/server/public/settings-registry.js")) as unknown as Registry;
  });
  return m!;
}

const detached = () => ({ isConnected: false, ownerDocument: {} });

let R: Registry;
beforeAll(async () => {
  (globalThis as Record<string, unknown>).window = shellStub();
  R = await freshRegistry();
});

describe("the boxes", () => {
  const denJobs = [...DEN_ROLES.map((r) => r.id), "install"];

  it("are Den's jobs in the registry's order, then Den's own agent", () => {
    expect(R.issueWriteJobs(null).map((j) => j.value)).toEqual(denJobs);
  });

  it("then a distribution's jobs and a persona's, none twice", () => {
    const jobs = R.issueWriteJobs({
      roles: [
        ...DEN_ROLES.map((r) => ({ id: r.id, description: "ignored" })),
        { id: "copy-writer", description: "Writes the words." },
      ],
      personas: [{ role: "lead" }, { role: "sde" }, { role: "copy-writer" }],
    });
    expect(jobs.map((j) => j.value)).toEqual([
      ...denJobs,
      "copy-writer",
      "lead",
    ]);
    const added = jobs.find((j) => j.value === "copy-writer")!;
    expect(added.help).toBe("Writes the words.");
    expect(added.label).not.toBe(added.value);
    expect(added.label[0]).toBe(added.label[0].toUpperCase());
    expect(added.label.toLowerCase()).toBe("copy writer");
  });

  it("show a name for every Den job, never its id", () => {
    for (const j of R.issueWriteJobs(null)) {
      expect(j.label.trim()).not.toBe("");
      expect(j.label).not.toBe(j.value);
      expect(j.help.trim()).not.toBe("");
    }
  });
});

describe("the saved list", () => {
  const jobs = [
    { value: "planner", label: "P", help: "" },
    { value: "designer", label: "D", help: "" },
  ];

  it("is the ticked jobs plus every saved role with no box here", () => {
    expect(
      R.issueWriteSave(["designer"], ["planner", "lead", "builder"], jobs),
    ).toEqual(["designer", "lead", "builder"]);
  });

  it("is empty when nothing is ticked", () => {
    expect(R.issueWriteSave([], ["planner", "lead"], jobs)).toEqual([]);
  });

  it("reads a list or comma text, trimmed, with no blanks or repeats", () => {
    expect(R.issueWriteRoles(" sde, reviewer,,sde ")).toEqual([
      "sde",
      "reviewer",
    ]);
    expect(R.issueWriteRoles(["a", " b ", "", "a"])).toEqual(["a", "b"]);
    expect(R.issueWriteRoles(null)).toEqual([]);
  });

  it("the row writes the same list it reads", () => {
    const row = R.DEN_SETTINGS.find((r) => r.id === ROW_ID)!;
    expect(row.control.type).toBe("custom");
  });
});

describe("the personas ask", () => {
  const ctxWith = (invalid: boolean) => {
    const api = jest.fn((_m: string, _p: string) =>
      Promise.resolve({ roles: [], personas: [] }),
    );
    return {
      api,
      ctx: {
        data: { agent_issue_writes: { roles: ["sde"] } },
        shell: { configInvalid: () => invalid, api },
      },
    };
  };
  const rowOf = (m: Registry) => m.DEN_SETTINGS.find((r) => r.id === ROW_ID)!;

  it("is never made under an invalid config", async () => {
    const m = await freshRegistry();
    const { api, ctx } = ctxWith(true);
    rowOf(m).control.render(detached(), ctx);
    await Promise.resolve();
    expect(api.mock.calls.map((c) => c[1])).not.toContain("/api/personas");
  });

  it("is made once otherwise", async () => {
    const m = await freshRegistry();
    const { api, ctx } = ctxWith(false);
    rowOf(m).control.render(detached(), ctx);
    rowOf(m).control.render(detached(), ctx);
    await Promise.resolve();
    expect(
      api.mock.calls.filter((c) => c[0] === "GET" && c[1] === "/api/personas"),
    ).toHaveLength(1);
  });
});

describe("the row's words", () => {
  const cat = catalogs();
  const title = (s: string) => (s.match(/__DEN_TITLE__/g) || []).length;

  it("are looked up for every job and the row's own lines", async () => {
    looked.length = 0;
    const m = await freshRegistry();
    m.issueWriteJobs(null);
    const row = m.DEN_SETTINGS.find((r) => r.id === ROW_ID)!;
    row.control.render(detached(), {
      data: { agent_issue_writes: null },
      shell: { configInvalid: () => true, api: () => Promise.resolve(null) },
    });
    const keys = looked.map(([k]) => k);
    for (const id of [...DEN_ROLES.map((r) => r.id), "install"])
      expect(keys).toEqual(
        expect.arrayContaining([`set.job.${id}`, `set.job.${id}.d`]),
      );
    expect(
      keys.filter((k) => k.startsWith("set.jobs.")).length,
    ).toBeGreaterThan(3);
  });

  it("are in en word for word as the row falls back to them", () => {
    expect(looked.length).toBeGreaterThan(0);
    for (const [k, en] of looked) expect([k, cat.en[k]]).toEqual([k, en]);
  });

  it("are in es and ja, keeping the product name", () => {
    for (const [k] of looked)
      for (const lang of ["es", "ja"]) {
        const v = cat[lang][k];
        expect([lang, k, typeof v === "string" && v.trim() !== ""]).toEqual([
          lang,
          k,
          true,
        ]);
        expect([lang, k, title(v)]).toEqual([lang, k, title(cat.en[k])]);
      }
  });

  it("the Agents section's intro is in en, es and ja", () => {
    for (const lang of ["en", "es", "ja"])
      expect(cat[lang]["setc.agents.d"]?.trim()).toBeTruthy();
  });

  it("show no command line, setting key or file name", () => {
    const keys = [
      ...looked.map(([k]) => k),
      "set.agents.issue_writes",
      "set.agents.issue_writes.d",
      "setc.agents.d",
    ];
    for (const lang of ["en", "es", "ja"])
      for (const k of keys) {
        const v = cat[lang][k] ?? "";
        expect([
          lang,
          k,
          /__DEN_CLI__|agents\.issue_writes|\.ya?ml\b/.test(v),
        ]).toEqual([lang, k, false]);
      }
  });
});
