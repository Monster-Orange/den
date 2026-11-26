/**
 * Issue 702: the bell line "Hub comments aren't arriving: <reason>",
 * one per install, while the delivery path has had no good read for
 * hub.delivery_alert_minutes. A new reason replaces it; the next good
 * read withdraws it. Never shown for a quiet Hub (deliveryAlert).
 */
import {
  TROUBLE_TEXT,
  type DeliveryTrouble,
} from "../../shared/hub-delivery.js";
import type { NotificationStore } from "../../shared/notifications.js";

export const HUB_COMMENTS_SUBJECT = "record:hub-comments-arriving";

/** Each reason's bell key (en in shell.js, es and ja in i18n/). */
export const HUB_COMMENTS_KEYS: Record<DeliveryTrouble, string> = {
  rejected: "bell.m.hubCommentsRejected",
  forbidden: "bell.m.hubCommentsForbidden",
  refused: "bell.m.hubCommentsRefused",
  unreachable: "bell.m.hubCommentsUnreachable",
  closed: "bell.m.hubCommentsClosed",
  silent: "bell.m.hubCommentsSilent",
  stale: "bell.m.hubCommentsStale",
};

/**
 * The bell's state keeper: call it with the alert now (a reason, or null).
 * It adds, replaces or withdraws only when that changes.
 */
export function hubCommentsBell(
  store: Pick<NotificationStore, "add" | "withdraw">,
): (reason: DeliveryTrouble | null) => void {
  // undefined: not yet called, so a row a restart left is withdrawn too.
  let said: DeliveryTrouble | null | undefined;
  return (reason) => {
    if (reason === said) return;
    said = reason;
    // The store keeps one unread row per subject and kind: a new reason
    // updates it in place.
    if (!reason) {
      store.withdraw(HUB_COMMENTS_SUBJECT, "service");
      return;
    }
    store.add({
      kind: "service",
      subject: HUB_COMMENTS_SUBJECT,
      scope: "workspace/den-server",
      text: `Hub comments aren't arriving: ${TROUBLE_TEXT[reason]}`,
      msg: { key: HUB_COMMENTS_KEYS[reason], vars: {} },
      link: "/settings#hub",
    });
  };
}
