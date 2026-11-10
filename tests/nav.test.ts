import { describe, expect, test } from 'bun:test';
import { NAV, TOOL_SECTIONS, isAnchor, searchNav } from '../src/v2/nav.ts';

/* The `⋯` menu and the ⌘K palette both render NAV. A destination that exists in
 * neither is unreachable, and a second hand-written list is how the two drift —
 * so these assertions are about coverage, order and honest search results. */

describe('nav registry', () => {
  test('the three top-level destinations come first', () => {
    expect(NAV.slice(0, 3).map((n) => n.id)).toEqual(['now', 'matches', 'prep']);
  });

  test('all six tools are anchored inside the tools sheet, in sheet order', () => {
    const tools = NAV.filter((n) => n.dest === 'tools');
    expect(tools.map((n) => n.anchor)).toEqual(['store', 'crosshair', 'prepick', 'resolution', 'chat', 'accounts']);
    expect(tools.every((n) => TOOL_SECTIONS.some((s) => s.id === n.anchor))).toBe(true);
  });

  test('settings is its own destination, not a tools anchor', () => {
    const settings = NAV.find((n) => n.id === 'settings');
    expect(settings?.dest).toBe('settings');
    expect(settings?.anchor).toBeUndefined();
  });

  test('ids are unique', () => {
    const ids = NAV.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an empty query matches everything', () => {
    expect(searchNav('').length).toBe(NAV.length);
  });

  test('a keyword finds what the label hides', () => {
    expect(searchNav('night market').map((n) => n.label)).toEqual(['Store']);
    expect(searchNav('stretch').map((n) => n.label)).toEqual(['Resolution']);
  });

  test('no match returns an empty list, not everything', () => {
    // A palette that shows all ten results for "zzzz" teaches the user it does
    // not filter; the empty list is the honest answer.
    expect(searchNav('zzzz')).toEqual([]);
  });

  test('isAnchor accepts exactly the six tool anchors', () => {
    expect(isAnchor('store')).toBe(true);
    expect(isAnchor('settings')).toBe(false);
    expect(isAnchor(null)).toBe(false);
  });
});
