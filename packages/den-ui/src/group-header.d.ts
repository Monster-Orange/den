/** Issue 750: one group's header in a list of agents by group. */
export interface GroupHeaderOptions {
  /** The group's name (escaped). */
  name: string;
  /** Its slug (data-group). */
  slug?: string;
  /** Its page in Hub: the name opens it in a new tab (http(s) only). */
  href?: string | null;
  /** The name link's title. */
  openLabel?: string;
  /** "Lead: …", the host's words; null: no lead. */
  lead?: string | null;
  /** How many rows follow it. */
  count?: number;
  /** Message group: a small link-button to Hub's composer, in a new tab. */
  action?: { label: string; href: string | null; name?: string } | null;
}

/** The header's HTML (group-header.css). */
export declare function groupHeaderHtml(o: GroupHeaderOptions): string;
