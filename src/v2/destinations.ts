/** Everything the app can navigate to, in one place.
 *
 *  The `⋯` menu and the ⌘K palette must offer the same list. Two hand-written
 *  lists drift — one gains a route, the other does not, and a destination
 *  quietly becomes unreachable. This is the single source; both read it.
 *
 *  `anchor` is a section inside the Tools sheet, not a route of its own: the
 *  six tools live on one page, so navigating to `#crosshair` is navigating to
 *  Tools and scrolling.
 */

export type Dest = 'now' | 'matches' | 'prep' | 'tools' | 'settings';

export interface Destination {
  /** Stable id; also the palette's key. */
  id: string;
  label: string;
  /** Sheet to open. */
  dest: Dest;
  /** Section inside the sheet, for the anchored Tools sections. */
  anchor?: 'store' | 'crosshair' | 'prepick' | 'resolution' | 'chat' | 'accounts';
  /** Extra words the palette should match on. */
  keywords?: string[];
}

export const DESTINATIONS: Destination[] = [
  { id: 'now', label: 'Now', dest: 'now', keywords: ['home', 'live', 'current'] },
  { id: 'matches', label: 'Matches', dest: 'matches', keywords: ['history', 'match', 'ledger'] },
  { id: 'prep', label: 'Prep', dest: 'prep', keywords: ['agents', 'maps', 'pools'] },

  { id: 'store', label: 'Store', dest: 'tools', anchor: 'store', keywords: ['shop', 'skins', 'bundle', 'night market'] },
  { id: 'crosshair', label: 'Crosshair', dest: 'tools', anchor: 'crosshair', keywords: ['reticle', 'sight', 'profile'] },
  { id: 'prepick', label: 'Pre-Picker', dest: 'tools', anchor: 'prepick', keywords: ['agent', 'hover', 'lineup'] },
  { id: 'resolution', label: 'Resolution', dest: 'tools', anchor: 'resolution', keywords: ['stretch', 'display', 'hz', 'gpu'] },
  { id: 'chat', label: 'Riot Chat', dest: 'tools', anchor: 'chat', keywords: ['friends', 'messages', 'party'] },
  { id: 'accounts', label: 'Accounts', dest: 'tools', anchor: 'accounts', keywords: ['login', 'vault', 'switch'] },

  { id: 'settings', label: 'Settings', dest: 'settings', keywords: ['preferences', 'theme', 'updates', 'about'] },
];

/** Rank by how well `query` matches; an empty query keeps the natural order.
 *
 *  Prefix beats substring beats keyword, so typing "c" puts Crosshair above
 *  Accounts rather than listing them in whatever order the array happens to be.
 *  Returns [] for a query that matches nothing — the palette must be able to say
 *  "no match" rather than showing everything and letting the user think it
 *  filtered. */
export function searchDestinations(query: string, list: Destination[] = DESTINATIONS): Destination[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  const scored = list
    .map((d) => {
      const label = d.label.toLowerCase();
      let score = 0;
      if (label.startsWith(q)) score = 3;
      else if (label.includes(q)) score = 2;
      else if ((d.keywords ?? []).some((k) => k.includes(q))) score = 1;
      return { d, score };
    })
    .filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((x) => x.d);
}
