export interface UpdatePillOptions {
  message: string;
  reloadLabel: string;
  dismissLabel: string;
  cancelLabel?: string;
  /** The pill's region name. */
  region?: string;
  /** A message to ask first (unsaved text), or null to reload at once. */
  askFirst?: () => { message: string } | null;
  onReload: () => void;
  onDismiss?: () => void;
}
export interface UpdatePill {
  hide(): void;
}
/** The shared update pill over the top bar. */
export declare function showUpdate(o: UpdatePillOptions): UpdatePill;
