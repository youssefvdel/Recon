import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as trn from '../src/utils/trn.ts';

/* contracts/trn-errors.json is the ONE list of TRN error codes the Rust
 * transport and the TS policy ladder must agree on. This test drives the REAL
 * exported predicates/constants from src/utils/trn.ts (no copied regexes) and
 * cross-checks the fixture's `rust` claims against the Rust source text, so a
 * rename on either side fails here. The Rust half of the same contract lives in
 * src-tauri/src/trn_http_rules.rs (`cargo test -p recon-pure`). */

interface ContractEntry {
  code: string;
  kind: 'code' | 'marker';
  match?: string;
  http: number | null;
  http_any_of?: number[];
  terminal: boolean;
  rust: string | null;
  rust_file: string | null;
  sample: string;
  ts: string[];
  cooldown?: boolean;
  note?: string;
}

interface Contract {
  version: number;
  codes: ContractEntry[];
}

const CONTRACT = JSON.parse(
  readFileSync(new URL('../contracts/trn-errors.json', import.meta.url), 'utf8')
) as Contract;

/** Real policy predicates. A fixture entry may only name one of these. */
const PREDICATES: Record<string, (msg: unknown) => boolean> = {
  isTrnAnswer: trn.isTrnAnswer,
  isTrnHttpStatus: trn.isTrnHttpStatus,
  isTrnPrivateMarked: trn.isTrnPrivateMarked,
  isTrnCaptcha: trn.isTrnCaptcha,
  isTrnMissingMarked: trn.isTrnMissingMarked,
  isTrnProxyRefusal: trn.isTrnProxyRefusal,
  isTrnProxyNotReady: trn.isTrnProxyNotReady,
  isTrnProxyPaused: trn.isTrnProxyPaused,
  isTrnNetDead: trn.isTrnNetDead,
  isTrnCooldownTrigger: trn.isTrnCooldownTrigger,
};

/** `not-an-answer` = transportGet's allowlist must reject the shape (fall back). */
const NOT_AN_ANSWER = 'not-an-answer';

const entries = CONTRACT.codes;
const codeOf = (e: ContractEntry): string => (e.match ?? e.code);

const rustFile = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('contracts/trn-errors.json', () => {
  test('is version 1 and has unique code identifiers', () => {
    expect(CONTRACT.version).toBe(1);
    const ids = entries.map((e) => e.code);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(20);
  });

  test('every entry declares a real TS predicate (or the fallback lane)', () => {
    for (const e of entries) {
      expect(e.ts.length).toBeGreaterThan(0);
      for (const name of e.ts) {
        if (name === NOT_AN_ANSWER) continue;
        expect(PREDICATES[name], `${e.code} names unknown predicate ${name}`).toBeFunction();
      }
    }
  });

  test('every declared predicate HOLDS for the entry sample', () => {
    for (const e of entries) {
      for (const name of e.ts) {
        if (name === NOT_AN_ANSWER) {
          // The transport allowlist is a denylist of failures: these shapes must
          // not reach the ladder as a tracker.gg answer.
          expect(trn.isTrnAnswer(e.sample), `${e.code} wrongly an answer`).toBe(false);
          expect(trn.isTrnHttpStatus(e.sample), `${e.code} wrongly an HTTP answer`).toBe(false);
          continue;
        }
        expect(PREDICATES[name](e.sample), `${name}(${e.code} sample)`).toBe(true);
      }
    }
  });

  test('the sample actually carries the code (stale samples cannot pass)', () => {
    for (const e of entries) {
      expect(e.sample.includes(codeOf(e)), `${e.code} sample lost its token`).toBe(true);
    }
  });

  test('the cooldown-ladder expectation matches isTrnCooldownTrigger', () => {
    for (const e of entries) {
      if (e.cooldown === undefined) continue;
      expect(trn.isTrnCooldownTrigger(e.sample), `cooldown(${e.code})`).toBe(e.cooldown);
    }
    // The three marks the ladder was built on, driven through the real predicate.
    expect(trn.isTrnCooldownTrigger('HTTP 429: rate limited')).toBe(true);
    expect(trn.isTrnCooldownTrigger('HTTP 403: Forbidden')).toBe(true);
    expect(trn.isTrnCooldownTrigger('HTTP 1015: you are being rate limited')).toBe(true);
  });

  test('the answer allowlist equals TRN_ANSWER_CODES exactly', () => {
    const answers = entries.filter((e) => e.ts.includes('isTrnAnswer')).map((e) => e.code);
    expect([...answers].sort()).toEqual([...trn.TRN_ANSWER_CODES].sort());
    // ...and those codes are the exported constants, not loose literals: a
    // rename on the TS side must reach the allowlist through the constant.
    const exportedTokens = new Set(
      Object.values(trn).filter(
        (v): v is string => typeof v === 'string' && /^(TRN|EDGE)_[A-Z_]+$/.test(v)
      )
    );
    for (const code of trn.TRN_ANSWER_CODES) {
      expect(exportedTokens.has(code), `${code} is not an exported constant`).toBe(true);
    }
  });

  test('terminal facts are exactly private + missing', () => {
    const terminal = entries.filter((e) => e.terminal).map((e) => e.code);
    expect([...terminal].sort()).toEqual(['TRN_NO_DATA', 'TRN_PRIVATE']);
  });

  test('status-derived entries agree with the documented statuses', () => {
    const byStatus = new Map(
      entries.filter((e) => e.http !== null).map((e) => [e.code, e.http as number])
    );
    expect(byStatus.get('TRN_PRIVATE')).toBe(451);
    expect(byStatus.get('TRN_NO_DATA')).toBe(404);
    expect(byStatus.get('TRN_RATE_LIMITED')).toBe(429);
    // Only those three are status-mapped; `HTTP {status}` is the catch-all.
    expect(byStatus.size).toBe(3);
    const catchAll = entries.find((e) => e.code === 'HTTP');
    expect(catchAll?.http).toBeNull();
    const captcha = entries.find((e) => e.code === 'TRN_CAPTCHA_REQUIRED');
    expect(captcha?.http).toBeNull();
    expect(captcha?.http_any_of).toEqual([429, 403]);
  });

  test('every code TS exports as a policy constant is in the fixture', () => {
    const exported = Object.entries(trn)
      .filter(([, v]) => typeof v === 'string' && /^(TRN|EDGE)_[A-Z_]+$/.test(v))
      .map(([, v]) => v as string);
    expect(exported.length).toBeGreaterThan(0);
    const listed = new Set(entries.map((e) => e.code));
    for (const token of exported) {
      expect(listed.has(token), `exported ${token} has no fixture entry`).toBe(true);
    }
  });

  test('every rust origin named by the fixture still emits that token', () => {
    for (const e of entries) {
      if (!e.rust_file) continue;
      expect(
        rustFile(e.rust_file).includes(codeOf(e)),
        `${e.rust_file} no longer contains ${codeOf(e)} (${e.rust})`
      ).toBe(true);
    }
  });

  test('the fixture documents every real mismatch it cannot fix in place', () => {
    // The known ladder gap is recorded, not hidden: a direct-transport 429 is
    // an answer (no edge fallback) but steps no cooldown. Changing either
    // behaviour must update this entry deliberately.
    const rateLimited = entries.find((e) => e.code === 'TRN_RATE_LIMITED');
    expect(rateLimited?.cooldown).toBe(false);
    expect(rateLimited?.note).toContain('policy gap');
    expect(trn.isTrnAnswer('TRN_RATE_LIMITED 25s')).toBe(true);
    expect(trn.isTrnCooldownTrigger('TRN_RATE_LIMITED 25s')).toBe(false);
  });
});
