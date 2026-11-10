import { describe, expect, test } from 'bun:test';
import {
  assertPlayerSettingsWriteResponse,
  buildPlayerSettingsPayload,
  canonicalJson,
  deflateRaw,
  inflateRaw,
} from '../src/utils/crosshairCodec';

const DOC = {
  currentProfile: 0,
  stringSettings: [{ settingEnum: 'Ares.Color', value: '255,0,0,255' }],
  boolSettings: [{ settingEnum: 'Ares.Bool', value: true }],
  note: 'é — unicode must survive the round-trip',
};

describe('buildPlayerSettingsPayload', () => {
  test('refuses a non-object document before any compression', async () => {
    for (const bad of [null, undefined, 'x', 42, true, []]) {
      await expect(buildPlayerSettingsPayload(bad)).rejects.toThrow('CROSSHAIR_PAYLOAD_INVALID');
    }
  });

  test('refuses a document over the 2 MB cap', async () => {
    const tooBig = { pad: 'x'.repeat(2_000_001) };
    await expect(buildPlayerSettingsPayload(tooBig)).rejects.toThrow('CROSSHAIR_PAYLOAD_SIZE');
  });

  test('refuses an empty or failed deflate', async () => {
    await expect(
      buildPlayerSettingsPayload(DOC, async () => '')
    ).rejects.toThrow('CROSSHAIR_PAYLOAD_DEFLATE');
    await expect(
      buildPlayerSettingsPayload(DOC, async () => 42 as unknown as string)
    ).rejects.toThrow('CROSSHAIR_PAYLOAD_DEFLATE');
  });

  test('emits the Ares.PlayerSettings envelope with the deflated document', async () => {
    const payload = await buildPlayerSettingsPayload(DOC);
    const parsed = JSON.parse(payload) as { type?: unknown; data?: unknown };
    expect(parsed.type).toBe('Ares.PlayerSettings');
    expect(typeof parsed.data).toBe('string');
    expect((parsed.data as string).length).toBeGreaterThan(0);
    expect(await inflateRaw(parsed.data as string)).toBe(JSON.stringify(DOC));
  });

  test('is deterministic byte-for-byte for the same input', async () => {
    const a = await buildPlayerSettingsPayload(DOC);
    const b = await buildPlayerSettingsPayload(DOC);
    expect(a).toBe(b);
  });
});

describe('deflate → inflate → canonical compare', () => {
  test('round-trips the exact document text', async () => {
    const text = JSON.stringify(DOC);
    expect(await inflateRaw(await deflateRaw(text))).toBe(text);
  });

  test('canonical comparison ignores key order', () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      canonicalJson({ b: { d: 3, c: 2 }, a: 1 })
    );
    // Arrays are ordered data, not key order: a reordered list must not match.
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  test('canonical comparison catches a changed value', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
    expect(canonicalJson({ a: { b: true } })).not.toBe(canonicalJson({ a: { b: false } }));
  });

  test('a truncated payload fails loudly instead of comparing equal', async () => {
    const encoded = await deflateRaw(JSON.stringify(DOC));
    await expect(inflateRaw(encoded.slice(0, Math.floor(encoded.length / 2)))).rejects.toThrow();
    await expect(inflateRaw('')).rejects.toThrow();
  });
});

describe('assertPlayerSettingsWriteResponse', () => {
  test('accepts { data: string }', () => {
    const ok = { data: 'deflated-b64' };
    expect(assertPlayerSettingsWriteResponse(ok)).toBe(ok);
    expect(assertPlayerSettingsWriteResponse({ data: '' })).toEqual({ data: '' });
  });

  test('throws for anything else', () => {
    for (const bad of [{}, { data: 1 }, { data: null }, null, undefined, 'data', 42, []]) {
      expect(() => assertPlayerSettingsWriteResponse(bad)).toThrow('CROSSHAIR_WRITE_RESPONSE');
    }
  });
});
