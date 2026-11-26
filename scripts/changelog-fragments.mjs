import * as fs from "node:fs";
import * as path from "node:path";

export const FRAGMENT_DIR = "changes";
export const FRAGMENT_NAME = /^changes\/(\d+)-[a-z0-9][a-z0-9-]*\.md$/;
export const FRAGMENT_SHAPE = "changes/<issue>-<slug>.md";
export const SECTIONS = [
  "Security",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Migrations",
  "Checks",
  "Tests",
  "Docs",
  "Known issues",
];

export class FragmentError extends Error {}

export const isFragmentPath = (f) =>
  f.startsWith(`${FRAGMENT_DIR}/`) && f !== `${FRAGMENT_DIR}/README.md`;

const trimBlank = (lines) => {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
};

function split(text) {
  const note = [];
  const sections = [];
  let cur = null;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], lines: [] };
      sections.push(cur);
    } else (cur ? cur.lines : note).push(line);
  }
  for (const s of sections) s.lines = trimBlank(s.lines);
  return { note: trimBlank(note), sections };
}

export function parseFragment(file, text) {
  if (!FRAGMENT_NAME.test(file))
    throw new FragmentError(
      `${file}: a changelog fragment is named ${FRAGMENT_SHAPE} (the issue's number, then lowercase words joined by -)`,
    );
  const { note, sections } = split(text);
  const bad = [];
  if (note.length) bad.push(`text before its first "### <section>" heading`);
  if (!sections.length) bad.push(`no "### <section>" heading`);
  for (const s of sections) {
    if (!SECTIONS.includes(s.name))
      bad.push(`"### ${s.name}" isn't a section (${SECTIONS.join(", ")})`);
    if (!s.lines.some((l) => /^\s*[-*] \S/.test(l)))
      bad.push(`"### ${s.name}" has no "- " line`);
    if (s.lines.some((l) => /^#{1,2}\s/.test(l)))
      bad.push(`"### ${s.name}" holds a "#" or "##" heading`);
  }
  if (bad.length) throw new FragmentError(`${file}: ${bad.join("; ")}`);
  return { file, issue: Number(FRAGMENT_NAME.exec(file)[1]), sections };
}

export function parseFragments(entries) {
  return entries
    .map(({ file, text }) => parseFragment(file, text))
    .sort((a, b) => a.issue - b.issue || (a.file < b.file ? -1 : 1));
}

export function fragmentsOnDisk(root = ".") {
  const dir = path.join(root, FRAGMENT_DIR);
  if (!fs.existsSync(dir)) return [];
  return parseFragments(
    fs
      .readdirSync(dir)
      .map((n) => `${FRAGMENT_DIR}/${n}`)
      .filter(isFragmentPath)
      .map((file) => ({
        file,
        text: fs.readFileSync(path.join(root, file), "utf8"),
      })),
  );
}

const order = (name, seen) => {
  const i = SECTIONS.indexOf(name);
  return i >= 0 ? i : SECTIONS.length + seen.indexOf(name);
};

export function assemble(log, fragments, version, date) {
  const lines = log.split("\n");
  const esc = version.replace(/\./g, "\\.");
  const unreleased = new RegExp(`^## \\[${esc}\\] - unreleased\\s*$`);
  const head = lines.findIndex((l) => unreleased.test(l));
  let start;
  let end;
  let body = "";
  if (head >= 0) {
    start = head;
    end = lines.findIndex((l, i) => i > head && /^## /.test(l));
    if (end < 0) end = lines.length;
    body = lines.slice(head + 1, end).join("\n");
  } else {
    if (!fragments.length) return null;
    start = lines.findIndex((l) => /^## \[/.test(l));
    if (start < 0) start = lines.length;
    end = start;
  }
  const entry = split(body);
  const merged = new Map();
  const seen = [];
  const add = (s) => {
    if (!merged.has(s.name)) {
      merged.set(s.name, []);
      seen.push(s.name);
    }
    merged.get(s.name).push(...s.lines);
  };
  for (const s of entry.sections) add(s);
  for (const f of fragments) for (const s of f.sections) add(s);
  const out = [`## [${version}] - ${date}`, ""];
  if (entry.note.length) out.push(...entry.note, "");
  for (const name of [...seen].sort((a, b) => order(a, seen) - order(b, seen)))
    out.push(`### ${name}`, "", ...merged.get(name), "");
  return [...lines.slice(0, start), ...out, ...lines.slice(end)].join("\n");
}
