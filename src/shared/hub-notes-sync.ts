/**
 * NT-6: Hub's notifications in Den's bell, and read both ways. One pass:
 * read Hub's list (the owner's, computed by Hub), fold it into the store
 * (NotificationStore.syncHub), then tell Hub about the ones read here.
 * Run on `notifications.hub_poll_seconds` (default 60) while Hub is
 * connected; Hub's own read marks reach Den on the next pass.
 *
 * Hub and the store are injected; nothing here throws: a Hub that doesn't
 * answer leaves the bell as it was, and says why once.
 */
import { parseHubNote, type NotificationStore } from "./notifications.js";

export interface HubNotesDeps {
  store: NotificationStore;
  /** The owner's login on Hub (whoami), whose reads count; null: unknown. */
  owner: () => string | null;
  list: () => Promise<{ items: unknown[] }>;
  markRead: (ids: string[]) => Promise<number>;
  log?: (line: string) => void;
}

export interface HubNotesPass {
  ok: boolean;
  /** Hub's items Den now shows. */
  items: number;
  /** Read here, told to Hub. */
  pushed: number;
}

export async function syncHubNotes(d: HubNotesDeps): Promise<HubNotesPass> {
  let raw: { items: unknown[] };
  try {
    raw = await d.list();
  } catch (e) {
    d.log?.(
      `hub notifications: Hub didn't list them: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
    );
    return { ok: false, items: 0, pushed: 0 };
  }
  const notes = raw.items
    .map(parseHubNote)
    .filter((n): n is NonNullable<typeof n> => !!n);
  const push = d.store.syncHub(notes, d.owner());
  let pushed = 0;
  if (push.length) {
    try {
      await d.markRead(push);
      d.store.hubMarked(push);
      pushed = push.length;
    } catch (e) {
      // Kept as read here; told to Hub on the next pass.
      d.log?.(
        `hub notifications: Hub didn't take the reads: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }
  return { ok: true, items: notes.length, pushed };
}
