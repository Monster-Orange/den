const MAX_PAGES = 100;

export async function allSessions(get, query = "") {
  let first = null;
  const sessions = [];
  let cursor = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const q = new URLSearchParams(query);
    if (cursor) q.set("cursor", cursor);
    const d = await get(`/api/sessions${q.size ? `?${q}` : ""}`);
    if (!d || !Array.isArray(d.sessions))
      return first ? { ...first, sessions } : d;
    first ??= d;
    sessions.push(...d.sessions);
    cursor = typeof d.next === "string" && d.next ? d.next : null;
    if (!cursor) break;
  }
  return { ...first, sessions, next: null };
}
