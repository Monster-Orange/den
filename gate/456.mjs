/* eslint-env browser */
// gate/456.mjs: Den picks the copy of an agent CLI that a new shell gets
// (issue 456). Setup makes stub copies of one catalog runtime in a folder
// of its own (gate456-*, under ctx.evidenceDir, else the OS temp dir), and a stub shell
// that puts them on the PATH it says: the interactive shell (-ilc) gets
// the newer copy first, the login shell (-lc) gets the older one first,
// as on the install the issue came from. It runs the bed's
// `agents doctor --json` with DEN_LOGIN_SHELL naming that stub shell (and
// DEN_RUNTIME_DIRS empty, so no install folder decides), set for that CLI
// run only: ctx.cli(args, { env, timeout }). Each stub only
// writes its own path to a log in that folder and prints a version: no
// vendor CLI is ever run by this check. On macOS a third copy carries
// com.apple.quarantine (set with xattr on that stub file only), and must
// never run. Then a stub shell that answers in 4 s: the PATH wait is a
// Setting (10 s by default), so its PATH is still read. Per cell, the
// page: Settings › Agents shows the Shell PATH wait row, and the runtime's
// row shows the copy used (and Use this beside any other copy Den's
// server found). Teardown removes the folder. No setting is changed.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 456;
export const clauses = [
  "with two copies on the PATH a new shell gets, Den uses the one that shell gets first, with no warning",
  "the other copies are listed with their versions, read from their files; Settings › Runtimes offers Use this",
  "a quarantined copy is never run, and reads 'quarantined, not run'",
  "the version command runs only on the chosen copy",
  "the shell PATH wait is a Setting (10 s by default): a shell that answers in 4 s is still read",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 180000;

/** Catalog runtimes whose CLI name is their id; the first one not pinned is used. */
const CANDIDATES = ["codex", "gemini", "grok"];
const NEW = "0.60.0";
const OLD = "0.30.0";
const QUAR = "0.20.0";
const QUARANTINE = "com.apple.quarantine";
// DEN_GATE_XATTR: another xattr to use (this check's unit test, off macOS).
const XATTR = process.env.DEN_GATE_XATTR || "/usr/bin/xattr";

/** A runtimes answer, as a list (the route answers a list or { runtimes }). */
const listOf = (v) =>
  Array.isArray(v) ? v : Array.isArray(v?.runtimes) ? v.runtimes : [];

/** The runtime this check stubs: in the catalog, and not pinned by a setting. */
async function pickRuntime(ctx) {
  let rows = [];
  try {
    const r = await ctx.api("/api/agents/runtimes");
    if (r.ok) rows = listOf(await r.json());
  } catch {
    rows = [];
  }
  for (const id of CANDIDATES) {
    const row = rows.find((x) => x.id === id);
    if (!row) continue;
    if (row.source === "setting" || row.source === "workspace") continue;
    return { id, bin: id };
  }
  return null;
}

/** A stub CLI: logs its own path, prints `version`, and exits. */
function writeStub(file, version, id, log) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh\necho "$0 $*" >> '${log}'\necho "${version} (${id}, a stub of this check)"\n`,
    { mode: 0o755 },
  );
}

/**
 * A stub shell for DEN_LOGIN_SHELL: logs its flags, waits `wait` s, then
 * runs Den's command with the PATH for those flags.
 */
function writeShell(file, { ilc, lc, wait, log }) {
  fs.writeFileSync(
    file,
    [
      "#!/bin/sh",
      `echo "$1" >> '${log}'`,
      wait ? `sleep ${wait}` : "",
      `if [ "$1" = "-ilc" ]; then PATH='${ilc}':"$PATH"; else PATH='${lc}':"$PATH"; fi`,
      "export PATH",
      'exec /bin/sh -c "$2"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

/** How long one `agents doctor` run may take (a 4 s shell, asked twice). */
const CLI_TIMEOUT_MS = 60000;

/**
 * A folder of this check's own for its stubs: under the harness's evidence
 * folder (ctx.evidenceDir), else the OS temp dir. Never the bed's folder
 * or Den's state folder.
 */
function stubFolder(ctx, prefix) {
  const e = ctx.evidenceDir;
  const base =
    typeof e === "string" && path.isAbsolute(e)
      ? e
      : typeof e === "function"
        ? e()
        : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/** Whether xattr can mark a file here (macOS only). */
const canQuarantine = () =>
  !!process.env.DEN_GATE_XATTR ||
  (process.platform === "darwin" && fs.existsSync(XATTR));

/** The lines of a log file this check owns ([] when none). */
function lines(file) {
  try {
    return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** `agents doctor --json` with the stub shell, its row for runtime `id`. */
async function doctorWith(ctx, shell, id) {
  const t0 = Date.now();
  // The harness sets these for that one CLI run only (DEN_* names, string
  // values). An older harness ignores the option: the stub shell's own log
  // then shows it was never asked (needs-harness-cli-env).
  const d = await ctx.cli(["agents", "doctor", "--json"], {
    env: { DEN_LOGIN_SHELL: shell, DEN_RUNTIME_DIRS: "" },
    timeout: CLI_TIMEOUT_MS,
  });
  const ms = Date.now() - t0;
  const out = String(d?.out ?? "");
  let row = null;
  let parsed = false;
  try {
    const j = JSON.parse(out.slice(out.indexOf("{")));
    parsed = true;
    row = listOf(j).find((r) => r.id === id) ?? null;
  } catch {
    row = null;
  }
  const text = `${out}\n${String(d?.err ?? "")}`;
  return {
    code: d?.code ?? null,
    ms,
    parsed,
    row: row && {
      available: row.available ?? null,
      path: row.path ?? null,
      source: row.source ?? null,
      version: row.version ?? null,
      quarantined: row.quarantined === true,
      why: row.why ?? null,
      others: (row.others ?? []).map((o) => ({
        path: o.path,
        version: o.version ?? null,
        source: o.source ?? null,
        quarantined: o.quarantined === true,
      })),
    },
    warned: /\bwarn(ing)?\b|⚠/i.test(row ? JSON.stringify(row) : ""),
    tail: text.slice(-300),
  };
}

export async function setup(ctx) {
  const tag = Date.now().toString(36);
  const state = { tag, dir: null, runtime: null, error: null };
  try {
    state.runtime = await pickRuntime(ctx);
    if (!state.runtime) return state;
    const dir = stubFolder(ctx, "gate456-");
    state.dir = dir;
    const { id, bin } = state.runtime;
    const runs = path.join(dir, "runs.log");
    const shells = path.join(dir, "shell.log");
    const newDir = path.join(dir, "new", "bin");
    const oldDir = path.join(dir, "old", "versions", OLD);
    const qDir = path.join(dir, "q", "versions", QUAR);
    writeStub(path.join(newDir, bin), NEW, id, runs);
    writeStub(path.join(oldDir, bin), OLD, id, runs);
    const quarantine = canQuarantine();
    if (quarantine) {
      writeStub(path.join(qDir, bin), QUAR, id, runs);
      // Only this check's own stub file, in its own folder.
      execFileSync(XATTR, [
        "-w",
        QUARANTINE,
        "0081;00000000;gate456;",
        path.join(qDir, bin),
      ]);
    }
    const ilc = [newDir, oldDir, ...(quarantine ? [qDir] : [])].join(":");
    // The login shell has the older copy first (the issue's install).
    const lc = [oldDir, newDir].join(":");
    const shell = path.join(dir, "shell.sh");
    writeShell(shell, { ilc, lc, wait: 0, log: shells });
    const slow = path.join(dir, "slow.sh");
    writeShell(slow, { ilc, lc, wait: 4, log: shells });

    state.paths = {
      new: path.join(newDir, bin),
      old: path.join(oldDir, bin),
      q: quarantine ? path.join(qDir, bin) : null,
    };
    state.quarantine = quarantine;
    state.fast = await doctorWith(ctx, shell, id);
    state.shellAsked = lines(shells);
    state.ran = lines(runs).map((l) => l.split(" ")[0]);
    fs.writeFileSync(runs, "");
    fs.writeFileSync(shells, "");
    state.slow = await doctorWith(ctx, slow, id);
    state.slowAsked = lines(shells);
    // The bed's PATH wait (unset: the default).
    try {
      const s = await ctx.api("/api/settings");
      const v = s.ok ? await s.json() : null;
      state.wait = v?.agents_shell?.path_timeout_seconds ?? null;
      state.waitKnown = !!v && "agents_shell" in v;
    } catch {
      state.wait = null;
      state.waitKnown = false;
    }
  } catch (e) {
    state.error = String(e?.message ?? e).slice(0, 300);
  }
  return state;
}

export async function run(ctx, s) {
  const page = { row: null, wait: null };
  if (ctx.page && s.runtime) {
    await ctx.goto(
      ctx.page,
      `/settings?runtime=${s.runtime.id}#agents.runtimes`,
    );
    const rt = ctx.page.locator(`.rt[data-runtime="${s.runtime.id}"]`);
    await rt
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    if (await rt.count()) {
      const others = rt.locator("[data-others] [data-copy]");
      page.row = {
        text: ((await rt.first().textContent()) ?? "").trim().slice(0, 400),
        others: await others.count(),
        useThis: await rt.locator("button[data-pin-path]").count(),
      };
      await rt
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
    }
    await ctx.shot(`runtimes-${ctx.browser}-${ctx.width}`);
    const w = ctx.page.locator(
      '.set-row[data-setting="agents.shell_path_wait"]',
    );
    await w
      .first()
      .waitFor({ timeout: 10000 })
      .catch(() => {});
    if (await w.count()) {
      const input = w.locator("input");
      page.wait = {
        value: (await input.count())
          ? await input
              .first()
              .inputValue()
              .catch(() => null)
          : null,
      };
    }
  }
  return { ...s, page };
}

export async function teardown(ctx, state) {
  const dir = state?.dir;
  // Only the folder this check made (named gate456-): its stubs and logs.
  if (dir && path.basename(dir).startsWith("gate456-") && fs.existsSync(dir))
    fs.rmSync(dir, { recursive: true, force: true });
}

/** One cell's rows. */
function rows(r, cell) {
  const c = (k, row) => ({ clause: clauses[k], ...row });
  if (r?.error)
    return clauses.map((_, k) => c(k, { ok: false, detail: r.error }));
  if (!r?.runtime)
    return clauses.map((_, k) =>
      c(k, {
        ok: null,
        skip: "needs-unpinned-runtime",
        detail: `none of ${CANDIDATES.join(", ")} is in the catalog unpinned`,
      }),
    );
  const f = r.fast;
  // The stub shell was never asked: this harness's CLI doesn't pass the env on.
  if (!r.shellAsked?.includes("-ilc") && !r.shellAsked?.includes("-lc"))
    return clauses.map((_, k) =>
      k === 4 && r.page?.wait
        ? c(k, {
            ok: r.page.wait.value === null || Number(r.page.wait.value) >= 1,
            detail: `Settings row there (${r.page.wait.value}); the 4 s shell was not run (the CLI got no DEN_LOGIN_SHELL)`,
          })
        : c(k, {
            ok: null,
            skip: "needs-harness-cli-env",
            detail: `ctx.cli didn't pass DEN_LOGIN_SHELL on: the stub shell was never asked (doctor: ${f?.code}, ${f?.tail ?? ""})`,
          }),
    );
  const row = f?.row;
  const others = row?.others ?? [];
  const old = others.find((o) => o.path === r.paths.old);
  const q = r.paths.q
    ? row?.path === r.paths.q
      ? { chosen: true, quarantined: row.quarantined }
      : others.find((o) => o.path === r.paths.q)
    : null;
  const out = [];
  out.push(
    c(0, {
      ok:
        !!row &&
        row.available === true &&
        row.path === r.paths.new &&
        row.source === "interactive-shell" &&
        row.version === NEW &&
        !f.warned,
      detail: row
        ? `used ${row.path} (${row.source}, ${row.version})${f.warned ? ", with a warning" : ""}; stub shell asked ${r.shellAsked.join(", ")}`
        : `no ${r.runtime.id} row in agents doctor --json (${f?.tail ?? ""})`,
    }),
  );
  const page = r.page?.row;
  out.push(
    c(1, {
      ok:
        !!old &&
        old.version === OLD &&
        (!page || page.others === 0 || page.useThis >= page.others),
      detail:
        (old
          ? `also ${old.path} (${old.version}, ${old.source})`
          : `the older copy isn't listed (others: ${JSON.stringify(others)})`) +
        (cell
          ? `; ${cell.browser}: ${page ? `${page.others} other copies on the server's own shell, ${page.useThis} Use this` : "no runtime row"}`
          : ""),
      evidence: cell ? [`runtimes-${cell.browser}-${cell.width}.png`] : [],
    }),
  );
  out.push(
    !r.quarantine
      ? c(2, {
          ok: null,
          skip: "needs-macos",
          detail: "com.apple.quarantine is a macOS attribute",
        })
      : c(2, {
          ok:
            !!q &&
            q.quarantined === true &&
            !r.ran.includes(r.paths.q) &&
            !(r.slow?.row?.path === r.paths.q),
          detail: `${q ? (q.chosen ? "the quarantined copy was chosen" : `listed${q.quarantined ? " quarantined, not run" : " without its quarantine"}`) : "the quarantined copy isn't listed"}; ran: ${r.ran.join(", ") || "none"}`,
        }),
  );
  out.push(
    c(3, {
      ok:
        r.ran.length > 0 &&
        r.ran.every((p) => p === r.paths.new) &&
        !r.ran.includes(r.paths.old),
      detail: `version commands ran on: ${r.ran.join(", ") || "none"}`,
    }),
  );
  const s = r.slow?.row;
  const wait = r.wait ?? 10;
  out.push(
    wait < 5
      ? c(4, {
          ok: null,
          skip: "needs-default-shell-wait",
          detail: `the bed's agents.shell_path_timeout_seconds is ${wait}, under the 4 s shell`,
        })
      : c(4, {
          ok:
            !!s &&
            s.path === r.paths.new &&
            s.source === "interactive-shell" &&
            r.waitKnown &&
            (!cell || !!r.page?.wait),
          detail: `a 4 s shell: ${s ? `used ${s.path} (${s.source})` : "no row"} in ${r.slow?.ms} ms; settings ${r.waitKnown ? `agents_shell ${r.wait ?? "unset (10)"}` : "have no agents_shell"}${cell ? `; ${cell.browser}: Settings row ${r.page?.wait ? `shows ${r.page.wait.value}` : "missing"}` : ""}`,
        }),
  );
  return out;
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ result: cells }];
  const per = list.map((c) => rows(c?.result, c?.cell));
  // A clause passes when it passes in every cell that ran it.
  return clauses.map((clause, k) => {
    const got = per.map((r) => r[k]);
    if (got.every((r) => r.ok === null)) return got[0];
    const ran = got.filter((r) => r.ok !== null);
    return {
      clause,
      ok: ran.every((r) => r.ok === true),
      detail: ran.map((r) => r.detail).join(" | "),
      evidence: ran.flatMap((r) => r.evidence ?? []),
    };
  });
}
