/**
 * Pure crosshair wire-format helpers: deflate/inflate, the `Ares.PlayerSettings`
 * envelope, the write-response contract and the order-independent comparison.
 *
 * No Tauri, no browser globals beyond the standard Web APIs (CompressionStream,
 * DecompressionStream, TextEncoder, atob/btoa), so this module runs unchanged in
 * the app and under `bun test`. Moved out of `crosshair.ts` by moving code only —
 * the call sites there import it from here.
 */

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export async function inflateRaw(b64: string): Promise<string> {
  const ds = new DecompressionStream('deflate-raw');
  const bytes: BlobPart = b64ToBytes(b64) as unknown as BlobPart;
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Response(stream).text();
}

export async function deflateRaw(text: string): Promise<string> {
  const cs = new CompressionStream('deflate-raw');
  // Attach the reader BEFORE writing: writer.write() applies backpressure and
  // never resolves on large docs if nobody is draining the readable side.
  const out = new Response(cs.readable).arrayBuffer();
  const writer = cs.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  await writer.close();
  const buf = await out;
  return bytesToB64(new Uint8Array(buf));
}

/** The wire size cap the settings doc must stay under before deflating. */
export const MAX_SETTINGS_DOC_BYTES = 2_000_000;

/**
 * One place builds the write body: validate the doc, deflate it, and refuse an
 * empty/failed compression before anything reaches the transport.
 *
 * `deflate` is injectable so the refusal branch is testable without mocking the
 * CompressionStream; production always uses the default.
 */
export async function buildPlayerSettingsPayload(
  data: unknown,
  deflate: (text: string) => Promise<string> = deflateRaw
): Promise<string> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('CROSSHAIR_PAYLOAD_INVALID');
  }
  const doc = JSON.stringify(data);
  if (!doc || doc.length > MAX_SETTINGS_DOC_BYTES) throw new Error('CROSSHAIR_PAYLOAD_SIZE');
  const compressed = await deflate(doc);
  if (typeof compressed !== 'string' || compressed.length === 0) {
    throw new Error('CROSSHAIR_PAYLOAD_DEFLATE');
  }
  return JSON.stringify({ type: 'Ares.PlayerSettings', data: compressed });
}

/**
 * The response contract of the preference write: `{ data: string }` or throw.
 * Throwing is deliberate — the caller's existing `catch → false` turns a bad
 * answer into "save failed".
 */
export function assertPlayerSettingsWriteResponse(j: unknown): { data: string } {
  if (j && typeof j === 'object' && typeof (j as { data?: unknown }).data === 'string') {
    return j as { data: string };
  }
  throw new Error('CROSSHAIR_WRITE_RESPONSE');
}

/** Order-independent JSON, for the read-back comparison. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}
