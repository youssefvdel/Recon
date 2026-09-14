import React, { useState, useEffect, useMemo } from 'react';
import { UserCheck, Check, X, Search } from 'lucide-react';
import {
  getPrepickConfig,
  setPrepickConfig,
  getPlayableAgents,
  getCompetitiveMaps,
  PREPICK_MAX_DELAY,
  type PrepickConfig,
  type ValorantMapInfo,
} from '../utils/prepick';

export const PrepickView: React.FC = () => {
  const [config, setConfig] = useState<PrepickConfig>(() => getPrepickConfig());
  const [maps, setMaps] = useState<ValorantMapInfo[]>([]);
  const [agents, setAgentsList] = useState<{ id: string; name: string; icon: string; role: string }[]>([]);
  const [loading, setLoading] = useState(true);

  // Modal for selecting an agent (either for default or a specific map)
  const [activePickerTarget, setActivePickerTarget] = useState<string | null>(null); // 'default' or lowercase mapName
  const [agentSearch, setAgentSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');

  useEffect(() => {
    let dead = false;
    Promise.all([getCompetitiveMaps(), getPlayableAgents()]).then(([mList, aList]) => {
      if (!dead) {
        setMaps(mList);
        setAgentsList(aList);
        setLoading(false);
      }
    });
    return () => {
      dead = true;
    };
  }, []);

  const handleToggleEnabled = () => {
    const next = !config.enabled;
    const updated = { ...config, enabled: next };
    setConfig(updated);
    setPrepickConfig(updated);
  };

  const handleDelayChange = (sec: number) => {
    const clamped = Math.min(PREPICK_MAX_DELAY, Math.max(1, Math.round(sec)));
    const updated = { ...config, pickDelaySec: clamped };
    setConfig(updated);
    setPrepickConfig(updated);
  };

  const handleAssignAgent = (agent: { id: string; name: string; icon: string }) => {
    if (!activePickerTarget) return;

    if (activePickerTarget === 'default') {
      const updated: PrepickConfig = {
        ...config,
        defaultAgentId: agent.id,
        defaultAgentName: agent.name,
      };
      setConfig(updated);
      setPrepickConfig(updated);
    } else {
      const updatedMapAgents = {
        ...config.mapAgents,
        [activePickerTarget]: {
          agentId: agent.id,
          agentName: agent.name,
          agentIcon: agent.icon,
        },
      };
      const updated: PrepickConfig = {
        ...config,
        mapAgents: updatedMapAgents,
      };
      setConfig(updated);
      setPrepickConfig(updated);
    }
    setActivePickerTarget(null);
  };

  const handleClearMapAgent = (e: React.MouseEvent, mapName: string) => {
    e.stopPropagation();
    const key = mapName.toLowerCase();
    const updatedMapAgents = { ...config.mapAgents };
    delete updatedMapAgents[key];
    const updated: PrepickConfig = {
      ...config,
      mapAgents: updatedMapAgents,
    };
    setConfig(updated);
    setPrepickConfig(updated);
  };

  const roles = useMemo(() => {
    const set = new Set<string>();
    agents.forEach((a) => {
      if (a.role) set.add(a.role);
    });
    return ['all', ...Array.from(set).sort()];
  }, [agents]);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => {
      const matchRole = roleFilter === 'all' || a.role.toLowerCase() === roleFilter.toLowerCase();
      const matchSearch = !agentSearch.trim() || a.name.toLowerCase().includes(agentSearch.toLowerCase());
      return matchRole && matchSearch;
    });
  }, [agents, roleFilter, agentSearch]);

  const defaultAgentObj = useMemo(() => {
    return agents.find((a) => a.id.toLowerCase() === config.defaultAgentId.toLowerCase() || a.name.toLowerCase() === config.defaultAgentName.toLowerCase());
  }, [agents, config.defaultAgentId, config.defaultAgentName]);

  const targetTitle = activePickerTarget === 'default'
    ? 'Default Fallback Agent'
    : activePickerTarget
    ? `${activePickerTarget.charAt(0).toUpperCase() + activePickerTarget.slice(1)} Agent`
    : '';

  return (
    <div className="h-full min-h-0 flex flex-col bg-m3-surface overflow-y-auto custom-scrollbar px-4 sm:px-8 py-5 select-none">
      <div className="max-w-5xl mx-auto w-full space-y-5 pb-12">
        {/* Top Header Card */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 sm:p-5 rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="w-11 h-11 rounded-2xl bg-m3-primary/10 border border-m3-primary/30 flex items-center justify-center text-m3-primary shrink-0">
              <UserCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base sm:text-lg font-bold text-m3-on-surface font-display">
                  Agent Safe Pre-Picker
                </h1>
                <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300">
                  SAFE HOVER ONLY
                </span>
              </div>
              <p className="text-[11px] text-m3-outline mt-0.5">
                Hovers your preferred agent per map the instant Agent Select opens, then locks it in after the delay below. Set the slider to {PREPICK_MAX_DELAY} to hover without ever locking.
              </p>
            </div>
          </div>

          {/* Master Toggle Switch */}
          <button
            type="button"
            role="switch"
            aria-checked={config.enabled}
            onClick={handleToggleEnabled}
            className="flex items-center gap-3 px-3.5 py-2 rounded-2xl bg-m3-surface-container-high hover:bg-m3-surface-container-highest border border-m3-outline-subtle transition-colors cursor-pointer shrink-0"
          >
            <span className={`text-[11px] font-mono font-bold tabular-nums uppercase ${config.enabled ? 'text-m3-primary' : 'text-m3-outline'}`}>
              Auto-Hover {config.enabled ? 'ON' : 'OFF'}
            </span>
            <div
              className={`w-9 h-5 flex items-center rounded-full p-0.5 transition-colors ${
                config.enabled ? 'bg-m3-primary' : 'bg-black/40 border border-m3-outline-subtle/70'
              }`}
            >
              <div
                className={`w-4 h-4 rounded-full shadow-sm transition-transform ${
                  config.enabled ? 'translate-x-4 bg-white' : 'translate-x-0 bg-m3-outline'
                }`}
              />
            </div>
          </button>
        </div>

        {/* Pick Delay Slider */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 sm:p-5 rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-m3-on-surface">Lock-in delay</span>
              <span className={`text-[11px] font-mono font-bold tabular-nums ${config.pickDelaySec >= PREPICK_MAX_DELAY ? 'text-amber-300' : 'text-m3-primary'}`}>
                {config.pickDelaySec >= PREPICK_MAX_DELAY ? 'Never lock' : `${config.pickDelaySec}s`}
              </span>
            </div>
            <input
              type="range"
              min={1}
              max={PREPICK_MAX_DELAY}
              step={1}
              value={config.pickDelaySec}
              onChange={(e) => handleDelayChange(Number(e.target.value))}
              className="w-full mt-2 m3-range"
              aria-label="Seconds after the instant hover before locking the agent in (60 = hover only)"
            />
            <p className="text-[11px] text-m3-outline mt-1">
              The hover fires instantly; this is how long to wait before locking that agent in. Slide to {PREPICK_MAX_DELAY} to hover only.
            </p>
          </div>
        </div>

        {/* Global Fallback Agent Banner */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 sm:p-4 rounded-2xl bg-m3-surface-container-lowest border border-m3-outline-subtle">
          <div className="flex items-center gap-3">
            {defaultAgentObj ? (
              <div className="w-10 h-10 rounded-xl overflow-hidden bg-m3-surface-container-highest border border-m3-primary/40 shrink-0">
                <img src={defaultAgentObj.icon} alt={defaultAgentObj.name} className="w-full h-full object-cover" />
              </div>
            ) : (
              <div className="w-10 h-10 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle flex items-center justify-center text-m3-outline shrink-0">
                <UserCheck className="w-4 h-4" />
              </div>
            )}
            <div>
              <div className="text-xs font-semibold text-m3-on-surface flex items-center gap-2">
                <span>Default Fallback Agent</span>
                <span className="text-[10px] font-normal text-m3-outline">
                  (Used when a map has no custom agent assigned)
                </span>
              </div>
              <div className="text-[11px] font-mono text-m3-primary font-bold mt-0.5">
                {config.defaultAgentName ? config.defaultAgentName : 'None selected (click to set)'}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setActivePickerTarget('default')}
            className="h-8 px-3.5 rounded-xl bg-m3-surface-container-high hover:bg-m3-surface-container-highest border border-m3-outline-subtle text-xs font-semibold text-m3-on-surface hover:text-m3-primary transition-colors cursor-pointer shrink-0"
          >
            {config.defaultAgentName ? 'Change Default' : 'Select Default'}
          </button>
        </div>

        {/* Maps Section Header */}
        <div className="flex items-center justify-between pt-1">
          <div>
            <h2 className="text-sm font-bold text-m3-on-surface font-display">
              Map-Specific Agent Lineup
            </h2>
            <p className="text-[11px] text-m3-outline">
              Assign a dedicated agent to hover for each specific map. Click any map card to pick.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] font-mono text-m3-outline bg-m3-surface-container px-2.5 py-1 rounded-full border border-m3-outline-subtle">
            <span>{Object.keys(config.mapAgents).length} Custom Picks</span>
          </div>
        </div>

        {/* Maps Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-28 rounded-2xl bg-m3-surface-container-high animate-pulse" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {maps.map((m) => {
              const mapKey = m.name.toLowerCase();
              const customPick = config.mapAgents[mapKey];
              const assignedAgent = customPick
                ? agents.find((a) => a.id.toLowerCase() === customPick.agentId.toLowerCase() || a.name.toLowerCase() === customPick.agentName.toLowerCase())
                : null;
              const hasCustom = !!assignedAgent;
              const activeAgent = assignedAgent || defaultAgentObj;

              return (
                <div
                  key={m.uuid || m.name}
                  onClick={() => setActivePickerTarget(mapKey)}
                  className={`group relative h-28 rounded-2xl border overflow-hidden cursor-pointer transition-all ${
                    hasCustom
                      ? 'border-m3-primary/60 hover:border-m3-primary shadow-sm hover:shadow-md'
                      : 'border-m3-outline-subtle hover:border-m3-outline'
                  }`}
                >
                  {/* Map Splash Background */}
                  <img
                    src={m.splash}
                    alt={m.name}
                    loading="lazy"
                    className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/60 to-black/40" />

                  {/* Card Content */}
                  <div className="relative z-10 h-full p-3 flex flex-col justify-between">
                    {/* Top: Map Name + Custom/Default Badge */}
                    <div className="flex items-center justify-between">
                      <span className="font-display font-black text-sm text-white tracking-wide drop-shadow-sm">
                        {m.name}
                      </span>
                      {hasCustom ? (
                        <div className="flex items-center gap-1">
                          <span className="px-1.5 py-0.5 rounded text-[8.5px] font-mono font-bold uppercase tracking-wider bg-m3-primary/30 border border-m3-primary/60 text-white shadow-xs">
                            Custom Pick
                          </span>
                          <button
                            type="button"
                            onClick={(e) => handleClearMapAgent(e, m.name)}
                            className="p-1 rounded bg-black/60 hover:bg-red-500/80 text-white/80 hover:text-white transition-colors cursor-pointer"
                            title={`Clear custom pick for ${m.name}`}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[8.5px] font-mono uppercase tracking-wider bg-black/50 border border-white/10 text-white/60">
                          Uses Default
                        </span>
                      )}
                    </div>

                    {/* Bottom: Agent Hover Info */}
                    <div className="flex items-center gap-2 pt-1">
                      {activeAgent ? (
                        <>
                          <div className={`w-8 h-8 rounded-lg overflow-hidden shrink-0 border ${hasCustom ? 'border-m3-primary shadow-xs' : 'border-white/20'} bg-black/60`}>
                            <img src={activeAgent.icon} alt={activeAgent.name} className="w-full h-full object-cover" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[11px] font-bold text-white truncate leading-tight">
                              {activeAgent.name}
                            </div>
                            <div className="text-[9.5px] font-mono text-white/60 truncate">
                              {activeAgent.role} • {hasCustom ? 'Target' : 'Fallback'}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="text-[11px] font-medium text-white/70 italic">
                          Click to assign an agent…
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Agent Selector Modal */}
      {activePickerTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs"
          onClick={() => setActivePickerTarget(null)}
        >
          <div
            className="w-full max-w-xl max-h-[85vh] flex flex-col rounded-3xl bg-m3-surface-container-low border border-m3-outline-subtle shadow-2xl overflow-hidden select-none"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-m3-outline-subtle flex items-center justify-between gap-3 shrink-0">
              <div>
                <h3 className="font-display font-bold text-base text-m3-on-surface">
                  Select Agent for {targetTitle}
                </h3>
                <p className="text-[11px] text-m3-outline">
                  Click an agent below to set as your auto-hover choice.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActivePickerTarget(null)}
                className="p-1.5 rounded-full text-m3-outline hover:text-m3-on-surface hover:bg-m3-surface-container-high transition-colors cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Filter Bar */}
            <div className="p-3 border-b border-m3-outline-subtle bg-m3-surface-container-lowest/50 flex flex-wrap items-center gap-2 shrink-0">
              <div className="flex-1 min-w-36 flex items-center gap-1.5 px-2.5 h-8 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle">
                <Search className="w-3.5 h-3.5 text-m3-outline shrink-0" />
                <input
                  type="text"
                  value={agentSearch}
                  onChange={(e) => setAgentSearch(e.target.value)}
                  placeholder="Search agent…"
                  className="w-full bg-transparent text-xs text-m3-on-surface placeholder:text-m3-outline/60 focus:outline-none"
                />
              </div>

              {/* Role filter buttons */}
              <div className="flex items-center gap-1 overflow-x-auto py-0.5">
                {roles.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRoleFilter(r)}
                    className={`px-2 py-1 rounded-lg text-[10.5px] font-semibold capitalize transition-colors cursor-pointer ${
                      roleFilter === r
                        ? 'bg-m3-primary text-m3-on-primary font-bold'
                        : 'bg-m3-surface-container-high text-m3-outline hover:text-m3-on-surface'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            {/* Agent Grid */}
            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2.5">
                {filteredAgents.map((ag) => {
                  const isCurrent =
                    activePickerTarget === 'default'
                      ? ag.id.toLowerCase() === config.defaultAgentId.toLowerCase() || ag.name.toLowerCase() === config.defaultAgentName.toLowerCase()
                      : config.mapAgents[activePickerTarget]?.agentId.toLowerCase() === ag.id.toLowerCase() ||
                        config.mapAgents[activePickerTarget]?.agentName.toLowerCase() === ag.name.toLowerCase();
                  return (
                    <button
                      key={ag.id}
                      type="button"
                      onClick={() => handleAssignAgent(ag)}
                      className={`relative group flex flex-col items-center p-2 rounded-2xl border transition-all cursor-pointer ${
                        isCurrent
                          ? 'bg-m3-primary/20 border-m3-primary ring-2 ring-m3-primary/50'
                          : 'bg-m3-surface-container-high/60 hover:bg-m3-surface-container-high border border-m3-outline-subtle hover:border-m3-primary'
                      }`}
                    >
                      {isCurrent && (
                        <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-m3-primary text-[#09060d] flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 stroke-[3]" />
                        </div>
                      )}
                      <div className="w-12 h-12 rounded-xl overflow-hidden bg-m3-surface-container-highest border border-m3-outline-subtle/60 group-hover:scale-105 transition-transform mb-1.5">
                        <img src={ag.icon} alt={ag.name} className="w-full h-full object-cover" />
                      </div>
                      <span className={`text-xs font-bold truncate w-full text-center ${isCurrent ? 'text-m3-primary' : 'text-m3-on-surface group-hover:text-m3-primary'}`}>
                        {ag.name}
                      </span>
                      <span className="text-[9.5px] font-mono text-m3-outline truncate w-full text-center">
                        {ag.role}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
