/**
 * Issue 578: one place for a Den docs page's address. Den doesn't serve
 * its own docs; they are published in its public repo, so a page links
 * docs/<file> at the running version's tag (the docs that match what
 * runs), or at main when the version isn't known.
 */
import { engineVersion } from "./paths.js";

/** Den's public repo, where its docs are published. */
export const DOCS_REPO = "https://github.com/Monster-Orange/den";

/** A release or dev version, as Den's tags name them (v<version>). */
const VERSION = /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/;
/** A plain docs file: no folders, Markdown only. */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** docs/<file> at `version`'s tag, or at main. Throws for a bad name. */
export function docsPageUrl(file: string, version: string | undefined): string {
  if (!FILE.test(file)) throw new Error(`not a docs file: ${file}`);
  const ref = version && VERSION.test(version) ? `v${version}` : "main";
  return `${DOCS_REPO}/blob/${ref}/docs/${file}`;
}

/** Settings › Hub's "What is Hub?" page, for the running version. */
export function hubDocsUrl(): string {
  return docsPageUrl("hub.md", engineVersion());
}
