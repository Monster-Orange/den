/**
 * Unit tests for changelog-parser.ts
 */

import { describe, it, expect } from "@jest/globals";
import { parseChangelog } from "../../../src/ui/server/changelog-parser.js";

describe("parseChangelog", () => {
  it("parses a single version entry with Added section", () => {
    const raw = `## [1.0.0] — 2026-01-01

### Added

- Feature one
- Feature two
`;
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].version).toBe("1.0.0");
    expect(entries[0].date).toBe("2026-01-01");
    expect(entries[0].sections.Added).toHaveLength(2);
    expect(entries[0].sections.Added[0].text).toBe("Feature one");
  });

  it("parses multiple version entries separated by ---", () => {
    const raw = `## [1.1.0] — 2026-02-01

### Added

- New feature

---

## [1.0.0] — 2026-01-01

### Fixed

- Bug fix
`;
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0].version).toBe("1.1.0");
    expect(entries[1].version).toBe("1.0.0");
  });

  it("captures free-form note text before the first section", () => {
    const raw = `## [1.0.0] — 2026-01-01

Special thanks to someone for their help.

### Added

- Feature
`;
    const entries = parseChangelog(raw);
    expect(entries[0].note).toBe("Special thanks to someone for their help.");
  });

  it("parses sub-bullets (indented with 2 spaces)", () => {
    const raw = `## [1.0.0] — 2026-01-01

### Added

- Main feature
  - Sub-detail one
  - Sub-detail two
`;
    const entries = parseChangelog(raw);
    expect(entries[0].sections.Added[0].sub).toEqual([
      "Sub-detail one",
      "Sub-detail two",
    ]);
  });

  it("handles multiple sections (Added, Fixed, Internal)", () => {
    const raw = `## [1.0.0] — 2026-01-01

### Added

- New thing

### Fixed

- Bug fix

### Internal

- Refactor
`;
    const entries = parseChangelog(raw);
    expect(Object.keys(entries[0].sections)).toEqual([
      "Added",
      "Fixed",
      "Internal",
    ]);
  });

  it("preserves raw markdown for each entry", () => {
    const raw = `## [1.0.0] — 2026-01-01

### Added

- Feature

---

## [0.9.0] — 2025-12-01

### Fixed

- Old fix
`;
    const entries = parseChangelog(raw);
    expect(entries[0].raw).toContain("## [1.0.0]");
    expect(entries[0].raw).toContain("- Feature");
    expect(entries[0].raw).not.toContain("---");
  });

  it("returns empty array for empty input", () => {
    expect(parseChangelog("")).toEqual([]);
  });

  it("returns empty array for changelog with only header and no versions", () => {
    expect(parseChangelog("# Changelog\n\nSome intro text.\n")).toEqual([]);
  });

  it("handles en-dash and em-dash separators", () => {
    const raw = `## [1.0.0] – 2026-01-01

### Added

- Feature
`;
    const entries = parseChangelog(raw);
    expect(entries[0].version).toBe("1.0.0");
  });

  it("handles last entry without trailing ---", () => {
    const raw = `## [1.0.0] — 2026-01-01

### Added

- Feature
`;
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0].sections.Added[0].text).toBe("Feature");
  });
});
