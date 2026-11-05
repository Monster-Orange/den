/**
 * What the version pop-up shows: the newest release only, or every
 * version once the reader asks for them, plus the one button that toggles
 * between the two (null when there is nothing earlier to show).
 */
export function changelogView(entries, showAll) {
  const list = Array.isArray(entries) ? entries : [];
  const earlier = list.length - 1;
  if (earlier < 1) return { shown: list.slice(0, 1), toggle: null };
  return {
    shown: showAll ? list : list.slice(0, 1),
    toggle: showAll
      ? { label: "Show latest only", expanded: true }
      : { label: `Show all versions (${earlier} earlier)`, expanded: false },
  };
}
