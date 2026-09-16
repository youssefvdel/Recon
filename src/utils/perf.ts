import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './ipc';

export interface PerfSample {
  t: number;
  /** Backend process working set. */
  rss_mb: number;
  /** Recon's own WebView2 renderers (tree-attributed). */
  webview_mb: number;
  /** rss_mb + webview_mb — the prominent series. */
  total_mb: number;
  cpu_pct: number;
}
export interface PerfStats {
  current: number;
  min: number;
  max: number;
  avg: number;
}
export interface PerfTimeline {
  samples: PerfSample[];
  paused: boolean;
  rss: PerfStats;
  webview: PerfStats;
  total: PerfStats;
  cpu: PerfStats;
}

/** 5s poll cadence; 720 slots = 1h ring. Mirrors perf.rs — checked by scripts/perf-check.ts. */
export const PERF_POLL_MS = 5000;
export const PERF_RING_CAP = 720;

/** min/max/avg/current over values (current = last). Empty → zeros. Pure — checked by scripts/perf-check.ts. */
export function summarizePerf(values: number[]): PerfStats {
  if (values.length === 0) return { current: 0, min: 0, max: 0, avg: 0 };
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { current: values[values.length - 1], min, max, avg: sum / values.length };
}

/** values → SVG polyline points for a w×h viewBox. Empty → ''. Flat input
 *  sits mid-box (no div-by-zero branch). Pass `domain` to share one y-scale
 *  across stacked series. Pure — checked by scripts/perf-check.ts. */
export function sparklinePoints(values: number[], w: number, h: number, pad = 2, domain?: [number, number]): string {
  if (values.length === 0) return '';
  const lo = domain ? domain[0] : Math.min(...values);
  const hi = domain ? domain[1] : Math.max(...values);
  const span = hi - lo || 1;
  const iw = w - pad * 2;
  const ih = h - pad * 2;
  return values
    .map((v, i) => {
      const x = pad + (i / Math.max(1, values.length - 1)) * iw;
      const y = h - pad - ((v - lo) / span) * ih;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Dev-only fetch: null outside Tauri (browser preview) — never throws into
 *  the dashboard. Call sites gate on `import.meta.env.DEV` (static, so prod
 *  dead-code-eliminates the poll) matching the trnLog convention. */
export async function fetchPerf(): Promise<PerfTimeline | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<PerfTimeline>('perf_poll');
  } catch {
    // ponytail: release stub Err + transient races both mean "no timeline", not an error box.
    return null;
  }
}
