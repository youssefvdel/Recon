/**
 * Recon ops worker (Cloudflare): usage-pulse receiver.
 * Notices stay in ops/notices.json on GitHub — this only takes the heartbeat.
 *
 * Routes:
 *   POST /pulse  {riot_id, ts, version} -> stored in D1, always 200 (never leaks errors)
 *   GET  /count?since=2026-10-01 -> {pulses, uniques} (needs ?key=ADMIN_KEY)
 *
 * Setup (one time):
 *   npm i -g wrangler && wrangler login
 *   wrangler d1 create recon-pulses
 *   # paste the database_id into wrangler.toml below
 *   wrangler d1 execute recon-pulses --file schema.sql
 *   wrangler secret put ADMIN_KEY   # any random string, used for /count
 *   wrangler deploy
 * Then set PULSE_URL in src/utils/ops.ts to https://<worker>.workers.dev/pulse
 */

export interface Env {
  DB: D1Database;
  ADMIN_KEY: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/pulse') {
      try {
        const body = (await req.json()) as Record<string, unknown>;
        await env.DB.prepare(
          'INSERT INTO pulses (ts, riot_id, version) VALUES (?, ?, ?)'
        )
          .bind(
            String(body.ts ?? new Date().toISOString()).slice(0, 64),
            String(body.riot_id ?? 'unknown').slice(0, 64),
            String(body.version ?? 'unknown').slice(0, 32)
          )
          .run();
      } catch {
        /* never fail the app for telemetry */
      }
      return Response.json({ ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/count') {
      if (url.searchParams.get('key') !== env.ADMIN_KEY) {
        return Response.json({ error: 'no' }, { status: 403 });
      }
      const since = url.searchParams.get('since') ?? '1970-01-01';
      const total = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM pulses WHERE ts >= ?'
      )
        .bind(since)
        .first<{ n: number }>();
      const uniques = await env.DB.prepare(
        'SELECT COUNT(DISTINCT riot_id) AS n FROM pulses WHERE ts >= ?'
      )
        .bind(since)
        .first<{ n: number }>();
      return Response.json({ pulses: total?.n ?? 0, uniques: uniques?.n ?? 0 });
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },
};
