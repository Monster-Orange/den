export type AttentionStateName = "needs" | "done" | "working" | "idle";
export interface AttentionRow {
  rank: number;
  order: "oldest" | "name";
  rail: boolean;
  bell: boolean;
  alert: boolean;
}
export type AttentionTable = Record<AttentionStateName, AttentionRow>;
export type AttentionOverride = Partial<
  Record<AttentionStateName, Partial<AttentionRow>>
>;
export interface AttentionItem {
  state: AttentionStateName | string;
  /** An ISO time: since when it waits (needs) or when it finished (done). */
  since?: string;
  name?: string;
  id?: string;
  /** Issue 96: the person's own order: the group (project) it is ordered in. */
  group?: string;
  /** Issue 96: its place in that group's order (0 first), when the person set one. */
  place?: number;
}
export interface AttentionCounts {
  needs: number;
  done: number;
  working: number;
  idle: number;
  rail: number;
  bell: number;
}
export declare const ATTENTION_STATES: readonly AttentionStateName[];
export declare const ATTENTION_TABLE: Readonly<AttentionTable>;
export declare function attentionTable(
  override?: AttentionOverride | Record<string, unknown> | null,
): AttentionTable;
export declare function attentionState(s?: {
  needs?: boolean;
  working?: boolean;
  done?: boolean;
}): AttentionStateName;
export declare function compareAttention(
  a: AttentionItem,
  b: AttentionItem,
  table?: AttentionTable,
): number;
export declare function sortByAttention<T extends AttentionItem>(
  items: readonly T[] | null | undefined,
  table?: AttentionTable,
): T[];
export declare function inPersonOrder<T extends AttentionItem>(
  sorted: readonly T[],
): T[];
export declare function attentionCounts(
  items: readonly AttentionItem[] | null | undefined,
  table?: AttentionTable,
): AttentionCounts;
