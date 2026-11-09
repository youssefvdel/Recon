/* Static Riot metadata from valorant-api.com, cached 30 days.
 *
 * Moved verbatim out of utils/tracker.ts. It is a source read — one external
 * system, its own cache — and moving it here is what lets rank move next: the
 * rank reader needs `seasonOrder`, and without this it would have to import
 * tracker and create the cycle the split exists to remove. */

let gameDataMem: { agents: Record<string, string>; maps: Record<string, string>; seasons: Record<string, string>; seasonOrder: string[]; tierIcons: Record<number, string>; agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>; weapons: Record<string, string> } | null = null;

const GAME_DATA_KEY = 'aspect_game_data_v3';

/** Latest valorant-api map index (mapUrl|uuid → display name), module-level so
 *  the SYNCHRONOUS read paths (persisted match state, caches) can re-derive a
 *  map name instead of trusting one stored by an older build. */
// Exported as a live binding: tracker's synchronous read paths use it to
// re-derive a map name, while only this module ever writes it.
export let mapIndexMem: Record<string, string> = {};

/** Static Riot metadata via public valorant-api.com, cached 30 days. */
export async function gameData(): Promise<{ agents: Record<string, string>; maps: Record<string, string>; seasons: Record<string, string>; seasonOrder: string[]; tierIcons: Record<number, string>; agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }>; weapons: Record<string, string> }> {
  if (gameDataMem) return gameDataMem;
  try {
    const raw = localStorage.getItem(GAME_DATA_KEY);
    if (raw) {
      const { savedAt, data } = JSON.parse(raw);
      if (Date.now() - savedAt < 30 * 24 * 3600 * 1000 && data?.agents && data?.tierIcons && data?.agentInfo) {
        gameDataMem = { agents: data.agents, maps: data.maps ?? {}, seasons: data.seasons ?? {}, seasonOrder: data.seasonOrder ?? [], tierIcons: data.tierIcons, agentInfo: data.agentInfo ?? {}, weapons: data.weapons ?? {} };
        mapIndexMem = gameDataMem.maps;
        return gameDataMem;
      }
    }
  } catch {}
  const agents: Record<string, string> = {};
  const maps: Record<string, string> = {};
  const seasons: Record<string, string> = {};
  let seasonOrder: string[] = [];
  const tierIcons: Record<number, string> = {};
  const agentInfo: Record<string, { name: string; icon: string; role: string; roleIcon: string }> = {};
  const weapons: Record<string, string> = {};
  try {
    const [aj, mj, cs, sn, ct, wj] = await Promise.all([
      fetch('https://valorant-api.com/v1/agents?isPlayableCharacter=true').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/maps').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/seasons/competitive').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/seasons').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/competitivetiers').then((r) => r.json()),
      fetch('https://valorant-api.com/v1/weapons').then((r) => r.json()),
    ]);
    for (const a of aj?.data ?? []) {
      if (a?.uuid && a?.displayName) {
        const id = String(a.uuid).toLowerCase();
        agents[id] = a.displayName;
        agentInfo[id] = {
          name: a.displayName,
          icon: String(a.displayIcon ?? ''),
          role: String(a.role?.displayName ?? ''),
          roleIcon: String(a.role?.displayIcon ?? ''),
        };
      }
    }
    for (const m of mj?.data ?? []) {
      if (m?.mapUrl && m?.displayName) {
        maps[String(m.mapUrl).toLowerCase()] = m.displayName;
        if (m?.uuid) maps[String(m.uuid).toLowerCase()] = m.displayName;
      }
    }
    // competitive uuid → "V26 · ACT V": episode from asset path, act from season name.
    const names: Record<string, string> = {};
    for (const s of sn?.data ?? []) {
      if (s?.uuid && s?.displayName) names[String(s.uuid).toLowerCase()] = s.displayName;
    }
    const compList = Array.isArray(cs?.data) ? cs.data : [];
    for (const c of compList) {
      const cuuid = String(c?.uuid ?? '').toLowerCase();
      const suuid = String(c?.seasonUuid ?? '').toLowerCase();
      if (!cuuid && !suuid) continue;
      const act = names[suuid] ?? '';
      const ep = /Episode(V\d+)/i.exec(String(c?.assetPath ?? ''))?.[1] ?? '';
      const label = [ep, act].filter(Boolean).join(' · ') || 'Season';
      // Riot keys player seasons by the SEASON uuid (SeasonID), not the
      // competitive uuid — index both so lookups always hit.
      if (cuuid) seasons[cuuid] = label;
      if (suuid) seasons[suuid] = label;
    }
    seasonOrder = compList
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .slice().sort((a: any, b: any) => String(b?.endTime ?? '').localeCompare(String(a?.endTime ?? '')))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => String(c?.seasonUuid ?? c?.uuid ?? '').toLowerCase()).filter(Boolean);
    // newest tier set wins; tier id matches Riot's numbering 0–27.
    const sets = Array.isArray(ct?.data) ? ct.data : [];
    const tiers = sets.length > 0 ? sets[sets.length - 1]?.tiers ?? [] : [];
    for (const t of tiers) {
      const id = Number(t?.tier);
      if (Number.isInteger(id) && t?.largeIcon) tierIcons[id] = String(t.largeIcon);
    }
    for (const w of wj?.data ?? []) {
      if (w?.uuid && w?.displayName) weapons[String(w.uuid).toLowerCase()] = w.displayName;
    }
    localStorage.setItem(GAME_DATA_KEY, JSON.stringify({ savedAt: Date.now(), data: { agents, maps, seasons, seasonOrder, tierIcons, agentInfo, weapons } }));
  } catch {}
  gameDataMem = { agents, maps, seasons, seasonOrder, tierIcons, agentInfo, weapons };
  mapIndexMem = maps;
  return gameDataMem;
}
