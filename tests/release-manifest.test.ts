import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BASE_URL,
  DEFAULT_NOTES,
  buildManifest,
  setupExeName,
} from '../scripts/make-latest-json.mjs';

/* latest.json is the one file the updater trusts: a wrong host, a path where
 * the signature bytes belong, or a renamed setup.exe silently kills updates
 * for everyone already installed. These assertions pin the wire shape. */

const SIGNATURE = 'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ==';
const PUB_DATE = new Date('2026-11-14T12:00:00.789Z');

const build = (overrides = {}) =>
  buildManifest({
    version: '0.4.4',
    notes: 'notes body',
    signature: SIGNATURE,
    pubDate: PUB_DATE,
    ...overrides,
  });

describe('release manifest', () => {
  test('url points at the release download for this version and exe', () => {
    const { platforms } = build();
    const url = new URL(platforms['windows-x86_64'].url);
    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('github.com');
    expect(url.pathname).toBe(
      '/youssefvdel/Outpeek/releases/download/v0.4.4/Outpeek_0.4.4_x64-setup.exe',
    );
  });

  test('version is passed through untouched', () => {
    const manifest = build({ version: '0.5.0-alpha7' });
    expect(manifest.version).toBe('0.5.0-alpha7');
    expect(manifest.platforms['windows-x86_64'].url).toContain(
      '/releases/download/v0.5.0-alpha7/Outpeek_0.5.0-alpha7_x64-setup.exe',
    );
  });

  test('signature is the content that was passed in, never a path', () => {
    const signature = build().platforms['windows-x86_64'].signature;
    expect(signature).toBe(SIGNATURE);
    expect(signature).not.toContain('/');
    expect(signature).not.toMatch(/\.sig$/);
  });

  test('the platform key is exactly windows-x86_64', () => {
    expect(Object.keys(build().platforms)).toEqual(['windows-x86_64']);
    expect(Object.keys(build().platforms['windows-x86_64']).sort()).toEqual(['signature', 'url']);
  });

  test('notes fall back to the release-page string when absent', () => {
    expect(build({ notes: undefined }).notes).toBe(DEFAULT_NOTES);
    // An empty notes file is a choice, not a missing file: keep it empty.
    expect(build({ notes: '' }).notes).toBe('');
  });

  test('pub_date is second-precision UTC', () => {
    expect(build().pub_date).toBe('2026-11-14T12:00:00Z');
    expect(build().pub_date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('the setup.exe name is Outpeek_<version>_x64-setup.exe', () => {
    expect(setupExeName('0.4.4')).toBe('Outpeek_0.4.4_x64-setup.exe');
    expect(setupExeName('0.5.0-alpha7')).toBe('Outpeek_0.5.0-alpha7_x64-setup.exe');
    // buildManifest derives the same name when none is supplied.
    expect(build().platforms['windows-x86_64'].url.endsWith(`/${setupExeName('0.4.4')}`)).toBe(true);
  });

  test('base url override still resolves to a release asset path', () => {
    const url = build({ baseUrl: 'https://example.test/Outpeek/' }).platforms['windows-x86_64'].url;
    expect(url).toBe(
      'https://example.test/Outpeek/releases/download/v0.4.4/Outpeek_0.4.4_x64-setup.exe',
    );
    expect(DEFAULT_BASE_URL).toBe('https://github.com/youssefvdel/Outpeek');
  });
});
