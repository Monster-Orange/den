/**
 * Changelog parser — parses Keep a Changelog format into structured entries.
 *
 * Extracted from server/index.ts. Used by the /api/changelog endpoint
 * and the startup banner version detection.
 */

export interface ChangelogBullet {
  text: string;
  sub: string[];
}

export interface ChangelogEntry {
  version: string;
  date: string;
  /** Free-form text between the version header and the first ### section. */
  note?: string;
  sections: Record<string, ChangelogBullet[]>;
  /** Raw markdown block for this version entry, suitable for sharing. */
  raw: string;
}

/**
 * Parse a Keep a Changelog-style CHANGELOG.md into structured entries.
 * Each section starts with: ## [version] — YYYY-MM-DD
 */
export function parseChangelog(raw: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const versionPattern = /^##\s+\[([^\]]+)\]\s*[—–-]\s*(\S+)/;
  const sectionPattern = /^###\s+(.+)/;

  let current: ChangelogEntry | null = null;
  let currentSection: string | null = null;
  let currentLines: string[] = [];

  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const vMatch = line.match(versionPattern);
    if (vMatch) {
      if (current) {
        current.raw = currentLines.join("\n").trimEnd();
        entries.push(current);
      }
      current = { version: vMatch[1], date: vMatch[2], sections: {}, raw: "" };
      currentSection = null;
      currentLines = [line];
      continue;
    }
    if (!current) continue;

    // Stop collecting raw lines when we hit the next version separator ("---")
    if (line.trim() === "---") {
      current.raw = currentLines.join("\n").trimEnd();
      entries.push(current);
      current = null;
      currentLines = [];
      continue;
    }

    currentLines.push(line);

    const sMatch = line.match(sectionPattern);
    if (sMatch) {
      currentSection = sMatch[1];
      current.sections[currentSection] = [];
      continue;
    }

    // Capture free text before the first ### section as a note
    if (!currentSection && line.trim() && !line.startsWith("#")) {
      current.note = (current.note ? current.note + " " : "") + line.trim();
    }

    if (currentSection && line.startsWith("- ")) {
      current.sections[currentSection].push({
        text: line.slice(2).trim(),
        sub: [],
      });
    } else if (currentSection && /^ {2}- /.test(line)) {
      const bullets = current.sections[currentSection];
      if (bullets.length > 0) {
        bullets[bullets.length - 1].sub.push(
          line.replace(/^ {2}- /, "").trim(),
        );
      }
    } else if (currentSection && /^ {2,}\S/.test(line)) {
      // A wrapped continuation line: it belongs to the bullet (or sub-bullet)
      // above it. Dropping it cut every multi-line bullet mid-sentence.
      const bullets = current.sections[currentSection];
      const last = bullets[bullets.length - 1];
      if (last) {
        const text = line.trim();
        if (/^ {4,}/.test(line) && last.sub.length > 0)
          last.sub[last.sub.length - 1] += " " + text;
        else last.text += " " + text;
      }
    }
  }
  if (current) {
    current.raw = currentLines.join("\n").trimEnd();
    entries.push(current);
  }
  return entries;
}
