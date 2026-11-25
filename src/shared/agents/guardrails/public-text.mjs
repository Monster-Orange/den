/**
 * Issue 1127, clause 4: text an agent files on GitHub from its shell (`gh pr
 * create|edit|comment|review`, `gh issue create|edit|comment`, and `gh api`
 * writes to issues, pulls, comments or GraphQL mutations) is checked for
 * listed names before the command runs. GitHub keeps every revision of an
 * edited body, so a check after posting is too late.
 *
 * The title and body come from --title/-t, --body/-b, --body-file/-F (a
 * file, or `-` for a heredoc or an earlier pipeline stage), -f/-F
 * key=value (and key=@file) and --input. Only public repos are checked: a
 * repo's visibility is asked of GitHub once and kept in a cache file, and
 * only when the text holds a hit. A repo whose visibility can't be found
 * is checked. The refusal quotes the agent's own phrase and offers neutral
 * words, so one retry fixes it; it never shows the list.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { orgHitsWide, orgPatterns } from "../../org-names.js";

/** Minutes a repo's visibility is kept (as agents.issue_writes_visibility_minutes). */
export const VISIBILITY_MINUTES = 10;

const NEUTRAL = `"the person", "the project", "the company" or "an internal host"`;

const PR_WRITES = new Set(["create", "edit", "comment", "review"]);
const ISSUE_WRITES = new Set(["create", "edit", "comment"]);
const words = (s) => new Set(s.split(" "));
/** Flags that take a value, per command: the same letter differs between them. */
const TEXT_FLAGS = "-R --repo -t --title -b --body -F --body-file";
const VALUE_FLAGS = {
  write: words(
    `${TEXT_FLAGS} -a --assignee -l --label -B --base -H --head -m --milestone ` +
      "-p --project -r --reviewer -T --template --recover --add-label " +
      "--remove-label --add-assignee --remove-assignee --add-reviewer " +
      "--remove-reviewer --add-project --remove-project",
  ),
  review: words(TEXT_FLAGS),
  api: words(
    "-X --method -f --raw-field -F --field -H --header --input -q --jq " +
      "-t --template -p --preview --hostname --cache",
  ),
};

const base = (w) => String(w).slice(String(w).lastIndexOf("/") + 1);

/** `--name value` / `--name=value` pairs and the positionals, in order. */
function options(args, valued) {
  const opts = [];
  const pos = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    const eq = /^(--[a-z-]+)=([\s\S]*)$/.exec(a);
    if (eq) opts.push([eq[1], eq[2]]);
    else if (valued.has(a) && j + 1 < args.length) opts.push([a, args[++j]]);
    else if (a.startsWith("-") && a.length > 1) opts.push([a, null]);
    else pos.push(a);
  }
  return { opts, pos };
}

/** owner/name from a GitHub URL or remote ("git@github.com:o/r.git"), or null. */
export function repoFromUrl(u) {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(
    String(u ?? ""),
  );
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The repo gh writes to from `cwd` with no --repo: GH_REPO, else the remote
 * gh resolved (remote.<name>.gh-resolved), else upstream, github, origin,
 * as gh picks; null when there is none.
 */
export function cwdRepo(cwd, env = process.env) {
  if (env.GH_REPO) return env.GH_REPO.replace(/^[^/]+\/(?=[^/]+\/[^/]+$)/, "");
  const r = spawnSync(
    "git",
    [
      "-C",
      cwd || ".",
      "config",
      "--get-regexp",
      "^remote\\..*\\.(url|gh-resolved)$",
    ],
    { encoding: "utf-8", timeout: 3000 },
  );
  if (r.status !== 0 || !r.stdout) return null;
  const urls = new Map();
  let resolved = null;
  for (const line of r.stdout.split("\n")) {
    const m = /^remote\.(.+)\.(url|gh-resolved) (.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[2] === "url") urls.set(m[1], m[3]);
    else if (m[3] === "base") resolved = m[1];
  }
  const pick =
    (resolved && urls.get(resolved)) ||
    urls.get("upstream") ||
    urls.get("github") ||
    urls.get("origin") ||
    [...urls.values()][0];
  return repoFromUrl(pick);
}

/** The heredoc bodies in a command, in order. */
export function heredocBodies(src) {
  const out = [];
  const re = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/g;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    const lines = rest.split("\n");
    const end = lines.findIndex((l) => l.replace(/^\t+/, "") === m[2]);
    out.push(lines.slice(0, end < 0 ? lines.length : end).join("\n"));
  }
  return out;
}

function readText(f, cwd, home) {
  try {
    let p = String(f);
    if (home && (p === "~" || p.startsWith("~/")))
      p = path.join(home, p.slice(1));
    return fs.readFileSync(path.resolve(cwd || ".", p), "utf-8");
  } catch {
    return null;
  }
}

/** A word's own text: `$(cat file)` read from the file, else as written. */
function wordText(w, ctx) {
  const m = /^\$\(\s*cat\s+(['"]?)([^\s'"()<]+)\1\s*\)$/.exec(String(w));
  if (m) return readText(m[2], ctx.cwd, ctx.home) ?? "";
  return String(w);
}

/** Text from a file argument: `-` is stdin (heredocs, earlier stages). */
function fileText(f, ctx) {
  if (f === "-") return ctx.stdin();
  return readText(f, ctx.cwd, ctx.home);
}

/**
 * The texts a `gh` stage would file and where it files them, or null when
 * it files nothing: { what, repo, texts: [{ where, text }] }. `repo` is
 * null when the stage doesn't name one (the cwd's repo is used).
 */
export function ghWrite(args, ctx) {
  let rest = args;
  let repoFlag = null;
  // `gh -R o/r pr create`: global flags before the command.
  while (rest[0] === "-R" || rest[0] === "--repo") {
    repoFlag = rest[1] ?? null;
    rest = rest.slice(2);
  }
  const [group, sub, ...more] = rest;
  const kind = group === "api" ? "api" : sub === "review" ? "review" : "write";
  // gh api's endpoint is its first positional, wherever its flags are.
  const { opts, pos } = options(
    kind === "api" ? rest.slice(1) : more,
    VALUE_FLAGS[kind],
  );
  const val = (...names) =>
    opts.filter(([k]) => names.includes(k)).map(([, v]) => v);
  repoFlag = val("-R", "--repo")[0] ?? repoFlag;
  const texts = [];
  if (
    (group === "pr" && PR_WRITES.has(sub)) ||
    (group === "issue" && ISSUE_WRITES.has(sub))
  ) {
    for (const t of val("-t", "--title"))
      texts.push({ where: "title", text: wordText(t, ctx) });
    for (const b of val("-b", "--body"))
      texts.push({ where: "body", text: wordText(b, ctx) });
    for (const f of val("-F", "--body-file")) {
      const t = f == null ? null : fileText(f, ctx);
      if (t != null)
        texts.push({
          where: f === "-" ? "body (stdin)" : `body file ${f}`,
          text: t,
        });
    }
    const url = pos.map(repoFromUrl).find(Boolean);
    return { what: `gh ${group} ${sub}`, repo: repoFlag ?? url ?? null, texts };
  }
  if (group !== "api") return null;
  const endpoint = String(pos[0] ?? "").replace(/^\//, "");
  const method = (val("-X", "--method")[0] ?? "").toUpperCase();
  const fields = [
    ...val("-f", "--raw-field").map((v) => ({ v, typed: false })),
    ...val("-F", "--field").map((v) => ({ v, typed: true })),
  ];
  const input = val("--input")[0];
  const writes =
    method !== "GET" &&
    (["POST", "PATCH", "PUT"].includes(method) || fields.length || input);
  if (!writes) return null;
  const graphql = endpoint === "graphql";
  const target =
    /^repos\/([^/]+)\/([^/]+)\/(issues|pulls|comments|commits\/[^/]+\/comments)(\/|$)/.exec(
      endpoint,
    );
  if (!graphql && !target) return null;
  for (const { v, typed } of fields) {
    const eq = String(v ?? "").indexOf("=");
    if (eq < 0) continue;
    const key = v.slice(0, eq);
    let text = v.slice(eq + 1);
    if (graphql ? key === "operationName" : !["title", "body"].includes(key))
      continue;
    if (typed && text.startsWith("@"))
      text = fileText(text.slice(1), ctx) ?? "";
    else text = wordText(text, ctx);
    texts.push({ where: `field ${key}`, text });
  }
  if (input) {
    const raw = fileText(input, ctx);
    if (raw != null) {
      let j = null;
      try {
        j = JSON.parse(raw);
      } catch {
        j = null;
      }
      if (j && typeof j === "object" && !graphql) {
        for (const k of ["title", "body"])
          if (typeof j[k] === "string")
            texts.push({ where: `input ${k}`, text: j[k] });
      } else texts.push({ where: `input ${input}`, text: raw });
    }
  }
  if (graphql && !texts.some((t) => /\bmutation\b/.test(t.text))) return null;
  const owner = target?.[1];
  const name = target?.[2];
  const named = owner && !owner.startsWith("{") && !name.startsWith("{");
  return {
    what: `gh api ${endpoint}`,
    repo: named ? `${owner}/${name}` : null,
    texts,
  };
}

/** Every hit: where, the 1-based line, and the agent's own phrase. */
export function phraseHits(texts, patterns, repo) {
  const allowed = repo ? [repo.replace(/[\s_-]+/g, "").toLowerCase()] : [];
  const hits = [];
  for (const { where, text } of texts)
    String(text ?? "")
      .split("\n")
      .forEach((line, i) => {
        for (const { index } of orgHitsWide(line, patterns, allowed)) {
          const m = new RegExp(patterns[index - 1].source, "i").exec(line);
          const phrase = (m ? m[0] : line.trim()).slice(0, 120);
          if (
            !hits.some(
              (h) =>
                h.where === where && h.line === i + 1 && h.phrase === phrase,
            )
          )
            hits.push({ where, line: i + 1, phrase });
        }
      });
  return hits;
}

function cacheFile(env) {
  const root =
    env.XDG_CACHE_HOME || (env.HOME ? path.join(env.HOME, ".cache") : "");
  return root ? path.join(root, "den", "repo-visibility.json") : "";
}

/**
 * "public", "private", "internal", or null when GitHub can't say. Asked
 * once per repo and kept for `minutes` in the cache file.
 */
export function repoVisibility(repo, opts = {}) {
  const env = opts.env ?? process.env;
  const file = opts.cache ?? cacheFile(env);
  const minutes = opts.minutes ?? VISIBILITY_MINUTES;
  const now = (opts.now ?? Date.now)();
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, "utf-8")) ?? {};
  } catch {
    cache = {};
  }
  const key = repo.toLowerCase();
  const kept = cache[key];
  if (kept && typeof kept.at === "number" && now - kept.at < minutes * 60_000)
    return kept.visibility;
  const r = spawnSync("gh", ["api", `repos/${repo}`, "--jq", ".visibility"], {
    encoding: "utf-8",
    timeout: 5000,
    env,
  });
  const v = r.status === 0 ? String(r.stdout).trim().toLowerCase() : "";
  if (!["public", "private", "internal"].includes(v)) return null;
  if (file)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ ...cache, [key]: { visibility: v, at: now } }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, file);
    } catch {
      // A cache that can't be written only means asking again next time.
    }
  return v;
}

/** The refusal: the agent's own phrases, neutral words, never the list. */
export function publicTextMessage(write, repo, hits, visibility) {
  const lines = hits.map(
    (h) => `  - ${h.where}, line ${h.line}: "${h.phrase}"`,
  );
  return [
    `Den held \`${write.what}\` before it ran: ${repo ?? "its repo"} ${visibility === "public" ? "is public" : "may be public (its visibility isn't known)"}, and this text names something that stays out of public text:`,
    ...lines,
    `Write it with neutral words instead, such as ${NEUTRAL}, then run the command again. Nothing was sent.`,
  ].join("\n");
}

/**
 * The reason to hold this Bash command, or null. `parse` is the hook's
 * shell parser (pipelines of stages).
 */
export function publicTextDecision(command, parse, opts = {}) {
  const env = opts.env ?? process.env;
  const src = String(command ?? "");
  if (!/\bgh\b/.test(src)) return null;
  const patterns = opts.patterns ?? orgPatterns(env);
  if (!patterns.length) return null;
  const pipelines = parse(src);
  const docs = heredocBodies(src);
  for (const stages of pipelines)
    for (let s = 0; s < stages.length; s++) {
      const st = stages[s];
      if (base(st.words[0] ?? "") !== "gh") continue;
      const ctx = {
        cwd: opts.cwd,
        home: env.HOME,
        // stdin: a heredoc on this command, or what earlier stages print.
        stdin: () =>
          [
            ...docs,
            ...stages
              .slice(0, s)
              .flatMap((e) =>
                base(e.words[0]) === "cat"
                  ? e.words
                      .slice(1)
                      .map((f) => readText(f, opts.cwd, env.HOME) ?? f)
                  : e.words
                      .slice(1)
                      .map((w) =>
                        wordText(w, { cwd: opts.cwd, home: env.HOME }),
                      ),
              ),
            ...st.inputs.map((f) => readText(f, opts.cwd, env.HOME) ?? ""),
          ].join("\n"),
      };
      const w = ghWrite(st.words.slice(1), ctx);
      if (!w || !w.texts.length) continue;
      const repo = w.repo ?? cwdRepo(opts.cwd, env);
      const hits = phraseHits(w.texts, patterns, repo);
      if (!hits.length) continue;
      const vis = repo
        ? repoVisibility(repo, { env, ...opts.visibility })
        : null;
      if (vis === "private" || vis === "internal") continue;
      return publicTextMessage(w, repo, hits, vis);
    }
  return null;
}
