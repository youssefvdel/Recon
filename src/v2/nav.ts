/** One navigation registry for the v2 shell.
 *
 *  The `⋯` menu and the ⌘K palette both render from NAV; a second array is how
 *  the two drift. Tools are not destinations of their own — each one is an
 *  anchor inside the single Tools sheet, so `anchor` is what the sheet scrolls
 *  to and what the URL hash carries for a deep link. */

export type Dest = 'now' | 'matches' | 'prep' | 'tools' | 'settings';
export type ToolAnchor = 'store' | 'crosshair' | 'prepick' | 'resolution' | 'chat' | 'accounts';

/** Sheet order. The sheet renders these sections in exactly this order. */
export const TOOL_SECTIONS: { id: ToolAnchor; label: string; keywords: string[] }[] = [
  { id: 'store', label: 'Store', keywords: ['shop', 'skins', 'night market', 'daily'] },
  { id: 'crosshair', label: 'Crosshair', keywords: ['reticle', 'aim', 'dot', 'profile'] },
  { id: 'prepick', label: 'Pre-Picker', keywords: ['prepicker', 'auto-hover', 'hover', 'lineup', 'map'] },
  { id: 'resolution', label: 'Resolution', keywords: ['res', 'stretch', 'scaling', 'gpu', 'display', 'hz', 'refresh'] },
  { id: 'chat', label: 'Riot Chat', keywords: ['friends', 'requests', 'blocked', 'messages', 'party'] },
  { id: 'accounts', label: 'Accounts', keywords: ['logins', 'switch', 'riot id', 'login'] },
];

export type NavGroup = 'Go' | 'Tools' | 'App';

export type NavItem = {
  id: string;
  label: string;
  group: NavGroup;
  /** Words a search may use that the label does not contain. */
  keywords: string[];
  dest: Dest;
  anchor?: ToolAnchor;
};

export const NAV: NavItem[] = [
  { id: 'now', label: 'Now', group: 'Go', keywords: ['live', 'lobby', 'act', 'home'], dest: 'now' },
  { id: 'matches', label: 'Matches', group: 'Go', keywords: ['history', 'ledger', 'games', 'feed'], dest: 'matches' },
  { id: 'prep', label: 'Prep', group: 'Go', keywords: ['agents', 'maps', 'pool', 'act'], dest: 'prep' },
  ...TOOL_SECTIONS.map<NavItem>((s) => ({
    id: `tool-${s.id}`,
    label: s.label,
    group: 'Tools',
    keywords: s.keywords,
    dest: 'tools',
    anchor: s.id,
  })),
  { id: 'settings', label: 'Settings', group: 'App', keywords: ['updater', 'startup', 'tray', 'preferences'], dest: 'settings' },
];

export const isAnchor = (v: string | null): v is ToolAnchor =>
  v !== null && TOOL_SECTIONS.some((s) => s.id === v);

/** Case-insensitive match on label + keywords; an empty query matches all. */
export const searchNav = (query: string): NavItem[] => {
  const q = query.trim().toLowerCase();
  if (!q) return NAV;
  return NAV.filter((n) => n.label.toLowerCase().includes(q) || n.keywords.some((k) => k.includes(q)));
};
