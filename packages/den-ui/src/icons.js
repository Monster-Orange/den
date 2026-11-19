/**
 * den-ui icons: the kit's 24px line drawings (the rail, the Report
 * button, the panel fold toggle and its edge strip). icon(name) gives an
 * <svg> string; a name it doesn't know, or markup starting with "<" (a
 * product's own drawing), is used as given, else the page icon. Pure: it
 * runs in Node too.
 */
export const ICONS = {
  // FB (den#81): the flat speech bubble with "!" (the Report button).
  report: '<path d="M4 5h16v11H9l-5 4V5z"/><path d="M12 8v4M12 14.2v.01"/>',
  overview: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
  graph:
    '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.2 7.2 15.6 8M7 8.4l1.6 7.2M16.4 10.2l-5.6 6"/>',
  services:
    '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>',
  logs: '<path d="M5 5h14M5 9h10M5 13h14M5 17h8"/>',
  tests:
    '<path d="M9 4h6M10 4v5l-5 9a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5-9V4"/>',
  envs: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
  releases: '<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  page: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6"/>',
  // The prototype's Agents icon: a terminal window with a prompt.
  agents:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10l3 2-3 2M12 15h5"/>',
  edge: '<path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z"/><path d="M8 12h8M12 8v8"/>',
  // D73: a terminal: a prompt and a cursor, no window.
  terminal: '<path d="M4 7l5 5-5 5M12 18h8"/>',
  // ON-6: the server agent, a speech bubble with a spark.
  assistant:
    '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M12 8v4M10 10h4"/>',
  // Hub: a node joined to three (the company's shared place).
  hub: '<circle cx="12" cy="12" r="2.5"/><circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/><circle cx="12" cy="20" r="2"/><path d="M6.6 7.2l3.5 3.2M17.4 7.2l-3.5 3.2M12 14.5V18"/>',
  // SEC-2a: who this browser is (the rail footer's identity chip).
  person:
    '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5"/>',
  // Issue 548: a window with its side column (the panel fold toggle).
  panel:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M15 5v14"/>',
  // Issue 549: an arrow out of the edge (the folded panel's Show panel).
  panelShow: '<path d="M10 6l-6 6 6 6M4 12h11M19 5v14"/>',
};

/** An icon's <svg>, aria-hidden (the label is beside it). */
export function icon(name) {
  const d = ICONS[name] || (/^</.test(name || "") ? name : ICONS.page);
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>";
}
