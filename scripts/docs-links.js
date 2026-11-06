/**
 * DOC-2's link check: every relative link in README.md and docs/*.md must
 * reach a file in the repo, and a `#fragment` must name a heading in the
 * file it points at (GitHub's anchors). External links (http:, https:,
 * mailto:) are not fetched. Links inside code fences and inline code are
 * not links.
 *
 *   node scripts/docs-links.js            (exit 1 on a broken link)
 *   npm run docs:links
 */
import fs from "node:fs";
import path from "node:path";

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces to dashes. */
export function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** Markdown without code: fenced blocks and inline code spans blanked. */
function prose(text) {
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

/** The anchors a markdown file's headings make (duplicates get -1, -2…). */
export function anchors(text) {
  const seen = new Map();
  const out = new Set();
  for (const m of prose(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** The link targets in a markdown file: [text](target) and <img src="target">. */
export function links(text) {
  const p = prose(text);
  return [
    ...[...p.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(
      (m) => m[1],
    ),
    ...[...p.matchAll(/<(?:img|source)\b[^>]*\b(?:src|srcset)="([^"]+)"/g)].map(
      (m) => m[1],
    ),
  ];
}

/**
 * The broken links in `files` (paths relative to `root`): [{ file, link, why }].
 */
export function brokenLinks(root, files) {
  const read = (f) => fs.readFileSync(path.join(root, f), "utf-8");
  const anchorCache = new Map();
  const anchorsOf = (f) => {
    if (!anchorCache.has(f)) anchorCache.set(f, anchors(read(f)));
    return anchorCache.get(f);
  };
  const out = [];
  for (const file of files) {
    for (const link of links(read(file))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // http:, https:, mailto:
      const [target, frag] = link.split("#", 2);
      const rel = target
        ? path.normalize(path.join(path.dirname(file), decodeURI(target)))
        : file;
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        out.push({ file, link, why: "points outside the repo" });
        continue;
      }
      if (!fs.existsSync(path.join(root, rel))) {
        out.push({ file, link, why: "no such file" });
        continue;
      }
      if (frag && /\.md$/i.test(rel) && !anchorsOf(rel).has(frag.toLowerCase()))
        out.push({ file, link, why: `no heading #${frag} in ${rel}` });
    }
  }
  return out;
}

/** README.md and every .md under docs/, relative to `root`. */
export function docFiles(root) {
  const out = fs.existsSync(path.join(root, "README.md")) ? ["README.md"] : [];
  const walk = (d) => {
    for (const e of fs.readdirSync(path.join(root, d), {
      withFileTypes: true,
    })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".md")) out.push(f);
    }
  };
  if (fs.existsSync(path.join(root, "docs"))) walk("docs");
  return out;
}

if (process.argv[1] && path.basename(process.argv[1]) === "docs-links.js") {
  const root = path.resolve(path.dirname(process.argv[1]), "..");
  const files = docFiles(root);
  const broken = brokenLinks(root, files);
  for (const b of broken) console.log(`${b.file}: ${b.link}: ${b.why}`);
  if (broken.length) {
    console.error(`docs-links: ${broken.length} broken link(s)`);
    process.exit(1);
  }
  console.log(`docs-links: ${files.length} files, every link resolves`);
}
