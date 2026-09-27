// Guards the overlay crosshair adapter: geometry must always contain the drawn
// extent (crisp even-pixel box), and persisted garbage must never reach the DOM.
//
//   bun scripts/crosshair-overlay-check.ts
import assert from 'node:assert/strict';
import {
  DEFAULT_OVERLAY_CROSSHAIR,
  crosshairHalfExtent,
  crosshairBox,
  sanitizeCrosshairShape,
  toReticleSection,
  type OverlayCrosshairShape,
} from '../src/utils/crosshairOverlay';

const fail = (msg: string): never => {
  console.error('CROSSHAIR_OVERLAY_FAIL: ' + msg);
  process.exit(1);
};

try {
  // 1. Even-pixel box keeps viewBox min on a whole pixel.
  const defBox = crosshairBox(DEFAULT_OVERLAY_CROSSHAIR);
  assert.ok(defBox.size > 0 && defBox.half > 0, 'default box must be positive');
  assert.equal(defBox.size % 2, 0, 'size must be even');
  assert.equal(Number.isInteger(defBox.half), true, 'half must be an integer');

  // 2. The box always contains the drawn extent (default + maxed-out shape).
  const maxed: OverlayCrosshairShape = {
    ...DEFAULT_OVERLAY_CROSSHAIR,
    gap: 20,
    length: 20,
    outlineThickness: 6,
    dotSize: 6,
    outlineOn: true,
  };
  for (const s of [DEFAULT_OVERLAY_CROSSHAIR, maxed]) {
    assert.ok(
      crosshairBox(s).half >= crosshairHalfExtent(s),
      'half must be >= drawn extent'
    );
  }

  // 3. Sanitiser clamps numbers and rejects invalid colours.
  const clamped = sanitizeCrosshairShape({ gap: 999, thickness: 0 });
  assert.equal(clamped.gap, 20, 'gap 999 must clamp to 20');
  assert.equal(clamped.thickness, 1, 'thickness 0 must clamp to 1');
  for (const bad of ['red', '#zzz', 123, null]) {
    assert.equal(
      sanitizeCrosshairShape({ core: bad, outline: bad }).core,
      DEFAULT_OVERLAY_CROSSHAIR.core,
      `core ${String(bad)} must fall back to default`
    );
    assert.equal(
      sanitizeCrosshairShape({ core: bad, outline: bad }).outline,
      DEFAULT_OVERLAY_CROSSHAIR.outline,
      `outline ${String(bad)} must fall back to default`
    );
  }
  for (const junk of [undefined, null, 'nonsense']) {
    const s = sanitizeCrosshairShape(junk);
    assert.equal(s.core, DEFAULT_OVERLAY_CROSSHAIR.core);
    assert.equal(s.outline, DEFAULT_OVERLAY_CROSSHAIR.outline);
  }

  // 4. Outline off when disabled OR zero thickness; outline stays opaque while
  //    inner-line opacity tracks the shape.
  assert.equal(
    toReticleSection({ ...DEFAULT_OVERLAY_CROSSHAIR, outlineOn: false }).bHasOutline,
    false
  );
  assert.equal(
    toReticleSection({ ...DEFAULT_OVERLAY_CROSSHAIR, outlineThickness: 0 }).bHasOutline,
    false
  );
  const section = toReticleSection({ ...DEFAULT_OVERLAY_CROSSHAIR, opacity: 0.5 }) as {
    outlineOpacity: number;
    innerLines: { opacity: number };
  };
  assert.equal(section.outlineOpacity, 1, 'outline must stay fully opaque');
  assert.equal(section.innerLines.opacity, 0.5, 'inner-line opacity tracks shape');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

console.log('CROSSHAIR_OVERLAY_PASS: geometry contains the drawn extent; garbage is clamped');
