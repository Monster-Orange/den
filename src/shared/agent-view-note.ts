/**
 * Issue 1243: said beside an agent's read-only view link (and in page_view's
 * description). The link is localhost on purpose: Den opens it on loopback
 * only, as the agent, so it is never handed to a person. No imports, so the
 * MCP tools can use it without loading the view's server-side code.
 */
export const AGENT_VIEW_LINK_NOTE =
  "This link is for your own browser on this machine, and opens only here, as you. Never give it to a person: to show a person a page, give them its address on this Den's web.url.";
