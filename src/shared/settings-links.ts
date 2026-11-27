export function settingsLink(pane: string, at?: string): string {
  const q = new URLSearchParams({ settings: pane });
  if (at) q.set("at", at);
  return `/?${q.toString()}`;
}

export function accountLink(pane: string): string {
  return `/?${new URLSearchParams({ account: pane }).toString()}`;
}
