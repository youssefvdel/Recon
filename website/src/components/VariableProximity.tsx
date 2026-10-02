import React, { forwardRef, useCallback, useMemo, useRef, useEffect, useLayoutEffect } from 'react';
import './VariableProximity.css';

interface Point {
  x: number;
  y: number;
}

function useAnimationFrame(callback: () => void) {
  useEffect(() => {
    let frameId: number;
    const loop = () => {
      callback();
      frameId = requestAnimationFrame(loop);
    };
    frameId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frameId);
  }, [callback]);
}

function useMousePositionRef(containerRef?: React.RefObject<HTMLElement | null>) {
  const positionRef = useRef<Point>({ x: -9999, y: -9999 });

  useEffect(() => {
    const updatePosition = (clientX: number, clientY: number) => {
      if (containerRef?.current) {
        const rect = containerRef.current.getBoundingClientRect();
        positionRef.current = { x: clientX - rect.left, y: clientY - rect.top };
      } else {
        positionRef.current = { x: clientX, y: clientY };
      }
    };

    const handleMouseMove = (ev: MouseEvent) => updatePosition(ev.clientX, ev.clientY);
    const handleTouchMove = (ev: TouchEvent) => {
      if (ev.touches[0]) updatePosition(ev.touches[0].clientX, ev.touches[0].clientY);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('touchmove', handleTouchMove);
    };
  }, [containerRef]);

  return positionRef;
}

export interface VariableProximityProps extends React.HTMLAttributes<HTMLSpanElement> {
  label: string;
  fromFontVariationSettings: string;
  toFontVariationSettings: string;
  containerRef?: React.RefObject<HTMLElement | null>;
  radius?: number;
  falloff?: 'linear' | 'exponential' | 'gaussian';
  className?: string;
  style?: React.CSSProperties;
}

const VariableProximity = forwardRef<HTMLSpanElement, VariableProximityProps>((props, ref) => {
  const {
    label,
    fromFontVariationSettings,
    toFontVariationSettings,
    containerRef,
    radius = 140,
    falloff = 'linear',
    className = '',
    onClick,
    style,
    ...restProps
  } = props;

  const letterRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const interpolatedSettingsRef = useRef<string[]>([]);
  const mousePositionRef = useMousePositionRef(containerRef);
  const lastPositionRef = useRef<Point>({ x: -9999, y: -9999 });

  /* ---------------------------------------------------------------- */
  /* Width reservation — the fix for the hover reflow.                  */
  /* ---------------------------------------------------------------- */
  /**
   * Pin every letter's inline-size to the width it occupies at the HEAVIEST
   * variation state.
   *
   * Why this and nothing else: the bolding is driven by `wght`/`opsz`, and in
   * Roboto Flex a heavier cut has a wider advance — measured on this headline,
   * wght 500 -> 950 grows a letter by 10.5-17%. Because each letter is its own
   * `inline-block`, that extra advance used to be handed straight to the line
   * box: the line got wider than the container, the browser found one word too
   * many, and it re-wrapped. That single extra line box is what threw the whole
   * hero around (measured at 1440px: 3 lines at rest -> 4 at full weight, with
   * the sub-copy and the CTA row sliding down 37px).
   *
   * Pinning the advance removes the variable from layout entirely. The line box
   * is then laid out ONCE, at the widest the text can ever get, and the bolder
   * glyphs simply grow into space that was already reserved for them. Line
   * breaks can no longer change, so the line count is identical at rest and at
   * full hover intensity, at every breakpoint.
   *
   * Glyphs are left-anchored in their reserved box rather than centred, which
   * spreads the surplus as even intra-word tracking instead of dumping it into
   * the word gaps — the type keeps its word rhythm and never collides, because a
   * letter's bold glyph exactly fills its own reservation.
   */
  const reserveLetterWidths = useCallback(() => {
    const letters = letterRefs.current.filter(Boolean) as HTMLSpanElement[];
    if (!letters.length) return;

    /* Snapshot what the proximity loop has written so we hand it back untouched,
       and drop the pins so the widest state is measured rather than the pin. */
    const previousSettings = letters.map((el) => el.style.fontVariationSettings);
    const previousTransition = letters.map((el) => el.style.transition);
    letters.forEach((el) => {
      el.style.width = '';
      el.style.transition = 'none';
      el.style.fontVariationSettings = toFontVariationSettings;
    });

    const fontSize = parseFloat(getComputedStyle(letters[0]).fontSize) || 0;
    const widths = letters.map((el) => el.getBoundingClientRect().width);

    letters.forEach((el, i) => {
      el.style.fontVariationSettings = previousSettings[i] || fromFontVariationSettings;
      el.style.transition = previousTransition[i];
      /* Store the reservation in `em`, NOT `px`. The advance scales linearly with
         the font-size, so an em pin keeps the reservation exact across every
         breakpoint (36 / 60 / 72px) and browser zoom without re-measuring — a
         pixel pin silently goes stale the moment the headline changes size. */
      el.style.width = fontSize > 0 ? `${widths[i] / fontSize}em` : '';
    });
  }, [toFontVariationSettings, fromFontVariationSettings]);

  /* Measure before the first paint so the reserved layout is what shows up. */
  useLayoutEffect(() => {
    reserveLetterWidths();
  }, [reserveLetterWidths]);

  useEffect(() => {
    let cancelled = false;

    /* Fonts settle after first paint, and every advance above was taken from
       whatever face was actually resolved at that moment — so measure again
       once the real face is in, or the reservations are the fallback font's. */
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (!cancelled) reserveLetterWidths();
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
    };
  }, [reserveLetterWidths]);

  const parsedSettings = useMemo(() => {
    const parseSettings = (settingsStr: string) =>
      new Map<string, number>(
        settingsStr
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const [name, value] = s.split(/\s+/);
            return [name.replace(/['"]/g, ''), parseFloat(value)];
          })
      );

    const fromSettings = parseSettings(fromFontVariationSettings);
    const toSettings = parseSettings(toFontVariationSettings);

    return Array.from(fromSettings.entries()).map(([axis, fromValue]) => ({
      axis,
      fromValue,
      toValue: toSettings.get(axis) ?? fromValue,
    }));
  }, [fromFontVariationSettings, toFontVariationSettings]);

  const calculateDistance = (x1: number, y1: number, x2: number, y2: number) =>
    Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

  const calculateFalloff = (distance: number) => {
    const norm = Math.min(Math.max(1 - distance / radius, 0), 1);
    switch (falloff) {
      case 'exponential':
        return norm ** 2;
      case 'gaussian':
        return Math.exp(-((distance / (radius / 2)) ** 2) / 2);
      case 'linear':
      default:
        return norm;
    }
  };

  useAnimationFrame(() => {
    if (!containerRef?.current) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const { x, y } = mousePositionRef.current;
    if (lastPositionRef.current.x === x && lastPositionRef.current.y === y) {
      return;
    }
    lastPositionRef.current = { x, y };

    letterRefs.current.forEach((letterRef, index) => {
      if (!letterRef) return;

      const rect = letterRef.getBoundingClientRect();
      const letterCenterX = rect.left + rect.width / 2 - containerRect.left;
      const letterCenterY = rect.top + rect.height / 2 - containerRect.top;

      const distance = calculateDistance(
        mousePositionRef.current.x,
        mousePositionRef.current.y,
        letterCenterX,
        letterCenterY
      );

      if (distance >= radius) {
        if (letterRef.style.fontVariationSettings !== fromFontVariationSettings) {
          letterRef.style.fontVariationSettings = fromFontVariationSettings;
        }
        return;
      }

      const falloffValue = calculateFalloff(distance);
      const newSettings = parsedSettings
        .map(({ axis, fromValue, toValue }) => {
          const interpolatedValue = fromValue + (toValue - fromValue) * falloffValue;
          return `'${axis}' ${interpolatedValue.toFixed(1)}`;
        })
        .join(', ');

      interpolatedSettingsRef.current[index] = newSettings;
      letterRef.style.fontVariationSettings = newSettings;
    });
  });

  const words = label.split(' ');
  let letterIndex = 0;

  return (
    <span
      ref={ref}
      className={`${className} variable-proximity`}
      onClick={onClick}
      style={{ display: 'inline', ...style }}
      {...restProps}
    >
      {words.map((word, wordIndex) => (
        <span key={wordIndex} style={{ display: 'inline-block', whiteSpace: 'nowrap' }}>
          {word.split('').map((letter) => {
            const currentLetterIndex = letterIndex++;
            return (
              <span
                key={currentLetterIndex}
                ref={(el) => {
                  letterRefs.current[currentLetterIndex] = el;
                }}
                style={{
                  display: 'inline-block',
                  fontVariationSettings: fromFontVariationSettings,
                  transition: 'font-variation-settings 0.05s ease',
                }}
                aria-hidden="true"
              >
                {letter}
              </span>
            );
          })}
          {wordIndex < words.length - 1 && <span style={{ display: 'inline-block' }}>&nbsp;</span>}
        </span>
      ))}
      <span className="variable-proximity-sr">{label}</span>
    </span>
  );
});

VariableProximity.displayName = 'VariableProximity';
export default VariableProximity;
