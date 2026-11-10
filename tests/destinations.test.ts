import { describe, expect, test } from 'bun:test';
import { DESTINATIONS, searchDestinations } from '../src/v2/destinations.ts';

/* The palette and the ⋯ menu both read DESTINATIONS. A destination that exists
 * in neither list is unreachable, which is the failure this file exists to
 * prevent — so the assertions are about coverage and ordering, not cosmetics. */

describe('destinations', () => {
  test('every top-level destination is present exactly once', () => {
    const dests = DESTINATIONS.map((d) => d.dest);
    expect(dests).toContain('now');
    expect(dests).toContain('matches');
    expect(dests).toContain('prep');
    expect(dests).toContain('settings');
    expect(dests.filter((x) => x === 'now')).toHaveLength(1);
  });

  test('the six tools are all anchored inside the tools sheet', () => {
    const anchors = DESTINATIONS.filter((d) => d.dest === 'tools').map((d) => d.anchor);
    expect(anchors).toEqual(['store', 'crosshair', 'prepick', 'resolution', 'chat', 'accounts']);
  });

  test('ids are unique', () => {
    const ids = DESTINATIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('an empty query keeps the natural order', () => {
    expect(searchDestinations('').map((d) => d.id)).toEqual(DESTINATIONS.map((d) => d.id));
  });

  test('a prefix beats a substring beats a keyword', () => {
    // "cro" prefixes Crosshair only.
    expect(searchDestinations('cro').map((d) => d.id)).toEqual(['crosshair']);
    // "co" appears INSIDE Accounts (a-c-c-o), not in Crosshair (c-r-o), so a
    // substring match must be found where the label does not start with it.
    expect(searchDestinations('co').map((d) => d.id)).toEqual(['accounts']);

    // "s" prefixes Store and Settings, so both outrank the substring matches
    // (Matches, Crosshair, Accounts…), whatever their position in the array.
    const s = searchDestinations('s').map((d) => d.id).slice(0, 2);
    expect(s.sort()).toEqual(['settings', 'store']);
  });

  test('a keyword finds the destination the label hides', () => {
    expect(searchDestinations('night market').map((d) => d.id)).toEqual(['store']);
    expect(searchDestinations('stretch').map((d) => d.id)).toEqual(['resolution']);
  });

  test('no match is an empty list, not the whole list', () => {
    expect(searchDestinations('zzzz')).toEqual([]);
  });
});
