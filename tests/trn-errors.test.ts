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
  /** Further Rust origins for the same code (one classifier, both transports). */
  rust_also?: Array<{ fn: string; file: string }>;
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
      const origins: Array<{ fn: string; file: string }> = [];
      if (e.rust && e.rust_file) origins.push({ fn: e.rust, file: e.rust_file });
      for (const also of e.rust_also ?? []) origins.push(also);
      for (const origin of origins) {
        expect(
          rustFile(origin.file).includes(codeOf(e)),
          `${origin.file} no longer contains ${codeOf(e)} (${origin.fn})`
        ).toBe(true);
      }
    }
  });

  test('a code emitted by both transports names both Rust origins', () => {
    const captcha = entries.find((e) => e.code === 'TRN_CAPTCHA_REQUIRED');
    expect(captcha?.rust).toContain('trn_http');
    expect(captcha?.rust_also?.map((o) => o.fn)).toContain('trn_proxy::result::map_result');
    // Both files carry the literal the classifier returns.
    expect(rustFile('src-tauri/src/trn_http_rules.rs')).toContain('TRN_CAPTCHA_REQUIRED');
    expect(rustFile('src-tauri/src/trn_proxy/result.rs')).toContain('TRN_CAPTCHA_REQUIRED');
  });

  test('a direct-transport 429 is an answer AND steps the ladder', () => {
    // The mismatch this contract used to document: the direct transport answers
    // the CODE with no numeric substring, so it reached the ladder with no
    // cooldown, no path stamp and no verdict. Both now hold, and the message
    // bytes are unchanged.
    const rateLimited = entries.find((e) => e.code === 'TRN_RATE_LIMITED');
    expect(rateLimited?.cooldown).toBe(true);
    expect(rateLimited?.ts).toContain('isTrnCooldownTrigger');
    expect(trn.isTrnAnswer('TRN_RATE_LIMITED 25s')).toBe(true);
    expect(trn.isTrnCooldownTrigger('TRN_RATE_LIMITED 25s')).toBe(true);
    // The edge shape still does, and a code that is not a rate limit never does.
    expect(trn.isTrnCooldownTrigger('HTTP 429: rate limited')).toBe(true);
    expect(trn.isTrnCooldownTrigger('TRN_NO_DATA')).toBe(false);
    expect(trn.isTrnCooldownTrigger('TRN_CAPTCHA_REQUIRED')).toBe(false);
  });

  test('the ladder steps exactly once, even when the message carries both marks', () => {
    trn.resetTrnCooldown();
    const before = trn.trnCooldownStepCount();
    // A message naming the code AND a numeric 429 matches two arms of the old
    // predicate; the single step must not run twice for it.
    expect(trn.stepTrnCooldown('TRN_RATE_LIMITED 429s')).toBe(true);
    expect(trn.trnCooldownStepCount()).toBe(before + 1);
    // The step persists a deadline and records the verdict the banner reads.
    expect(trn.trnCooldownRemainingMs()).toBeGreaterThan(0);
    expect(trn.getTrnHealth().health).toBe('rate-limited');
    // A non-trigger never steps.
    expect(trn.stepTrnCooldown('TRN_NO_DATA')).toBe(false);
    expect(trn.trnCooldownStepCount()).toBe(before + 1);
    // Keep the shared module state clean for other tests.
    trn.resetTrnCooldown();
    trn.resetTrnHealth();
  });
});
