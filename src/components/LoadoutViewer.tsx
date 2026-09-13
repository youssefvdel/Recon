import React, { useEffect, useMemo, useState } from 'react';
import { X, Loader2, Crosshair, User } from 'lucide-react';
import type { LiveMatchPlayer } from '../types';
import {
  playerCardIcon,
  playerCardLarge,
  loadWeaponCatalog,
  type PlayerLoadout,
  type WeaponCatalog,
  type EquippedExpression,
} from '../utils/loadout';

/* ------------------------------------------------------------------ */
/* Header & Section Title Primitives (Material Design 3)               */
/* ------------------------------------------------------------------ */

const CategoryHeader: React.FC<{ title: string; className?: string }> = ({ title, className = '' }) => (
  <div className={`flex items-center gap-2 justify-center py-0.5 select-none ${className}`}>
    <div className="h-[1px] flex-1 bg-m3-outline-subtle/40" />
    <span className="font-display font-bold text-[10.5px] tracking-[0.18em] text-m3-primary/90 uppercase text-center shrink-0">
      {title}
    </span>
    <div className="h-[1px] flex-1 bg-m3-outline-subtle/40" />
  </div>
);

/* ------------------------------------------------------------------ */
/* Weapon Card Component (Flexible 1fr Height, Material 3 Surface)     */
/* ------------------------------------------------------------------ */

interface SlotItemData {
  weaponName: string;
  skinName: string;
  icon: string;
  isDefaultSkin: boolean;
  variantLabel: string;
  level: number;
  buddyName: string;
  buddyIcon: string;
}

const WeaponCard: React.FC<{
  slot: SlotItemData;
  className?: string;
}> = ({ slot, className = '' }) => {
  const subLine = [slot.variantLabel, slot.level > 0 ? `Lv ${slot.level}` : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <div
      className={`flex-1 min-h-0 bg-m3-surface-container-low hover:bg-m3-surface-container-high border border-m3-outline-subtle/70 hover:border-m3-primary/60 rounded-xl transition-all duration-200 overflow-hidden flex flex-col justify-between p-1.5 select-none shadow-m3-1 hover:shadow-m3-2 group relative ${className}`}
      title={`${slot.weaponName} • ${slot.skinName}${subLine ? ` • ${subLine}` : ''}${slot.buddyName ? ` • Buddy: ${slot.buddyName}` : ''}`}
    >
      {/* Centered weapon artwork */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-0.5 relative">
        {slot.icon ? (
          <img
            src={slot.icon}
            alt={slot.skinName}
            loading="lazy"
            className="max-h-[85%] max-w-[92%] object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)] group-hover:scale-105 transition-transform duration-200"
          />
        ) : (
          <Crosshair className="w-4 h-4 text-m3-outline/40" />
        )}
        {/* Equipped gun buddy */}
        {slot.buddyIcon && (
          <img
            src={slot.buddyIcon}
            alt={slot.buddyName}
            title={slot.buddyName ? `Buddy: ${slot.buddyName}` : 'Gun buddy'}
            loading="lazy"
            className="absolute top-0 right-0 w-10 h-10 rounded-full object-cover border border-m3-outline-subtle bg-m3-surface-container-high shadow-md"
          />
        )}
      </div>

      {/* Bottom baseline: weapon label and equipped skin name */}
      <div className="px-1 pb-0.5 pt-1 min-w-0 shrink-0 border-t border-m3-outline-subtle/30 flex flex-col">
        <div className="flex items-center justify-between gap-1 min-w-0">
          <span className="font-mono text-[8.5px] text-m3-outline uppercase tracking-wider truncate">
            {slot.weaponName}
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {subLine && (
              <span className="text-[8px] font-mono font-bold text-amber-300/90 truncate" title={subLine}>
                {subLine}
              </span>
            )}
            {!slot.isDefaultSkin && (
              <span className="w-1.5 h-1.5 rounded-full bg-m3-primary shrink-0 shadow-[0_0_6px_rgba(208,188,255,0.7)]" />
            )}
          </div>
        </div>
        <span
          className={`text-[10px] font-semibold tracking-wide truncate max-w-full ${
            slot.isDefaultSkin ? 'text-m3-on-surface-variant/80' : 'text-m3-primary'
          }`}
          title={slot.skinName}
        >
          {slot.skinName}
        </span>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Full Player Card Component with Bottom Fade                         */
/* ------------------------------------------------------------------ */

const PlayerCardContainer: React.FC<{
  player: LiveMatchPlayer;
  cardSrc: string;
  onImgError: () => void;
}> = ({ player, cardSrc, onImgError }) => {
  return (
    <div className="flex-1 min-h-0 w-full max-w-[200px] rounded-2xl bg-m3-surface-container-low border border-m3-outline-subtle/80 hover:border-m3-primary/50 shadow-m3-2 overflow-hidden relative flex flex-col justify-between transition-colors group">
      {/* Level Chip floating cleanly inside the top */}
      <div className="absolute top-2 inset-x-0 flex justify-center z-20 pointer-events-none">
        <div className="bg-m3-surface-dim/80 backdrop-blur-md border border-m3-outline-subtle/80 rounded-full px-2 py-0.5 font-mono text-[10px] font-bold text-m3-primary shadow-m3-1 flex items-center gap-1 select-none">
          <span className="text-m3-outline text-[8px]">&lt;</span>
          <span>{player.accountLevel || 1}</span>
          <span className="text-m3-outline text-[8px]">&gt;</span>
        </div>
      </div>

      {/* Full Vertical Card Artwork */}
      {cardSrc ? (
        <img
          src={cardSrc}
          alt="Player Card"
          className="absolute inset-0 w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          onError={onImgError}
        />
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-m3-outline text-xs font-mono gap-1">
          <User className="w-7 h-7 text-m3-outline/40" />
          <span className="text-[11px]">No Card Equipped</span>
        </div>
      )}

      {/* Bottom Fade Overlay with Player Identity */}
      <div className="absolute inset-x-0 bottom-0 pt-16 pb-2.5 px-2.5 bg-gradient-to-t from-m3-surface-dim via-m3-surface-dim/85 to-transparent z-10 flex flex-col items-center text-center pointer-events-none select-none">
        <span className="font-display font-black text-[13px] leading-tight text-white uppercase tracking-wider block truncate max-w-full drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">
          {player.name}
        </span>
        <span className="text-[10px] font-semibold text-m3-primary/95 tracking-wide drop-shadow-[0_1px_3px_rgba(0,0,0,0.8)] mt-0.5">
          {player.agentName || 'Agent'}
        </span>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Expressions (Sprays & Flex) Radial Wheel Component (1:1 Aspect)     */
/* ------------------------------------------------------------------ */

const ExpressionsWheel: React.FC<{ items: EquippedExpression[] }> = ({ items }) => {
  const slots = [
    { label: 'Pre-Round', pos: 'top-[2%] left-1/2 -translate-x-1/2', item: items[0] },
    { label: 'Round Start', pos: 'top-1/2 right-[2%] -translate-y-1/2', item: items[1] },
    { label: 'Post-Round', pos: 'bottom-[2%] left-1/2 -translate-x-1/2', item: items[2] },
    { label: 'Flex / Combat', pos: 'top-1/2 left-[2%] -translate-y-1/2', item: items[3] },
  ];

  return (
    <div className="relative w-full max-w-[190px] aspect-square mx-auto flex items-center justify-center shrink-0">
      {/* Outer faint ring */}
      <div className="absolute inset-[1%] rounded-full border border-m3-outline-subtle/40" />
      {/* Middle concentric ring */}
      <div className="absolute inset-[22%] rounded-full border border-m3-outline-subtle/25" />
      {/* Central hub */}
      <div className="absolute w-[20%] h-[20%] max-w-9 max-h-9 rounded-full border border-m3-outline-subtle bg-m3-surface-container-high shadow-inner flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-m3-primary/70 shadow-[0_0_6px_rgba(208,188,255,0.7)]" />
      </div>

      {/* Radial spokes */}
      <div className="absolute w-full h-[1px] bg-m3-outline-subtle/25 rotate-45" />
      <div className="absolute w-full h-[1px] bg-m3-outline-subtle/25 -rotate-45" />
      <div className="absolute w-full h-[1px] bg-m3-outline-subtle/25 rotate-0" />
      <div className="absolute h-full w-[1px] bg-m3-outline-subtle/25" />

      {/* 4 Cardinal slots (Enlarged Circles) */}
      {slots.map((slot, i) => (
        <div
          key={i}
          className={`absolute ${slot.pos} w-[31%] h-[31%] max-w-14 max-h-14 rounded-full bg-m3-surface-container-high border-1.5 border-m3-outline-subtle hover:border-m3-primary hover:shadow-m3-2 flex items-center justify-center overflow-hidden shadow-md transition-all group cursor-pointer`}
          title={slot.item?.name ? `${slot.label}: ${slot.item.name}` : `${slot.label} (Empty)`}
        >
          {slot.item?.icon ? (
            <img
              src={slot.item.icon}
              alt={slot.item.name || slot.label}
              loading="lazy"
              className="w-[82%] h-[82%] object-contain group-hover:scale-110 transition-transform"
            />
          ) : (
            <div className="w-2 h-2 rounded-full bg-m3-outline-subtle" />
          )}
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 19 Live Weapons Slot Definitions (Canonical Valorant Collection)   */
/* ------------------------------------------------------------------ */

const SLOTS = {
  // Col 1: SIDEARMS (5 live weapons)
  CLASSIC: { id: '29a0cfab-485b-f5d5-779a-b59f85e204a8', name: 'CLASSIC' },
  SHORTY: { id: '42da8ccc-40d5-affc-beec-15aa47b42eda', name: 'SHORTY' },
  FRENZY: { id: '44d4e95c-4157-0037-81b2-17841bf2e8e3', name: 'FRENZY' },
  GHOST: { id: '1baa85b4-4c70-1284-64bb-6481dfc3bb4e', name: 'GHOST' },
  SHERIFF: { id: 'e336c6b8-418d-9340-d77f-7a9e4cfe0702', name: 'SHERIFF' },

  // Col 2: SMGS & SHOTGUNS
  STINGER: { id: 'f7e1b454-4ad4-1063-ec0a-159e56b58941', name: 'STINGER' },
  SPECTRE: { id: '462080d1-4035-2937-7c09-27aa2a5c27a7', name: 'SPECTRE' },
  BUCKY: { id: '910be174-449b-c412-ab22-d0873436b21b', name: 'BUCKY' },
  JUDGE: { id: 'ec845bf4-4f79-ddda-a3da-0db3774b2794', name: 'JUDGE' },

  // Col 3: RIFLES & MELEE
  BULLDOG: { id: 'ae3de142-4d85-2547-dd26-4e90bed35cf7', name: 'BULLDOG' },
  GUARDIAN: { id: '4ade7faa-4cf1-8376-95ef-39884480959b', name: 'GUARDIAN' },
  PHANTOM: { id: 'ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a', name: 'PHANTOM' },
  VANDAL: { id: '9c82e19d-4575-0200-1a81-3eacf00cf872', name: 'VANDAL' },
  MELEE: { id: '2f59173c-4bed-b6c3-2191-dea9b58be9c7', name: 'MELEE' },

  // Col 4: SNIPER RIFLES & MACHINE GUNS
  MARSHAL: { id: 'c4883e50-4494-202c-3ec3-6b8a9284f00b', name: 'MARSHAL' },
  OUTLAW: { id: '5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c', name: 'OUTLAW' },
  OPERATOR: { id: 'a03b24d3-4319-996d-0f8c-94bbfba1dfc7', name: 'OPERATOR' },
  ARES: { id: '55d8a0f4-4274-ca67-fe2c-06ab45efdf58', name: 'ARES' },
  ODIN: { id: '63e6c2b6-4a8e-869c-3d4c-e38355226584', name: 'ODIN' },
};

/* ------------------------------------------------------------------ */
/* Main Loadout Viewer Modal (Material Design 3 Dialog)                */
/* ------------------------------------------------------------------ */

export const LoadoutViewer: React.FC<{
  player: LiveMatchPlayer;
  loadout: PlayerLoadout | null;
  loading: boolean;
  ambiguous?: boolean;
  unavailableReason?: string | null;
  onClose: () => void;
}> = ({ player, loadout, loading, ambiguous, unavailableReason, onClose }) => {
  const [catalog, setCatalog] = useState<WeaponCatalog | null>(null);

  // Close on Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load catalog so default weapon icons and chromas resolve instantly
  useEffect(() => {
    loadWeaponCatalog().then(setCatalog).catch(() => {});
  }, []);

  // Map equipped weapons by UUID (lowercase)
  const equippedMap = useMemo(() => {
    const map = new Map<string, SlotItemData>();
    if (loadout) {
      for (const w of loadout.weapons) {
        map.set(w.weaponUuid.toLowerCase(), {
          weaponName: w.weaponName,
          skinName: w.skinName,
          icon: w.icon,
          isDefaultSkin: w.isDefaultSkin,
          variantLabel: w.variantLabel,
          level: w.level,
          buddyName: w.buddyName,
          buddyIcon: w.buddyIcon,
        });
      }
    }
    return map;
  }, [loadout]);

  // Resolve slot data: equipped skin if present, else canonical default weapon from catalog
  const getSlot = (def: { id: string; name: string }): SlotItemData => {
    const id = def.id.toLowerCase();
    const equipped = equippedMap.get(id);
    if (equipped && equipped.icon) {
      return {
        ...equipped,
        weaponName: def.name,
      };
    }
    const defaultWeapon = catalog?.weapons[id];
    return {
      weaponName: def.name,
      skinName: `Standard ${def.name}`,
      icon: defaultWeapon?.icon || '',
      isDefaultSkin: true,
      variantLabel: '',
      level: 0,
      buddyName: '',
      buddyIcon: '',
    };
  };

  const cardArt = player.cardId ? playerCardLarge(player.cardId) : '';
  const cardFallback = player.cardId ? playerCardIcon(player.cardId) : '';
  const [cardImgFailed, setCardImgFailed] = useState(false);
  const cardSrc = cardImgFailed ? cardFallback : cardArt || cardFallback;

  const rioId = `${player.name}${player.tag ? '#' + player.tag : ''}`;

  return (
    <div
      className="m3-modal-backdrop fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-md p-2 sm:p-3"
      onClick={onClose}
    >
      <div
        className="m3-modal-panel w-full max-w-[1360px] h-[calc(100vh-24px)] max-h-[780px] rounded-2xl sm:rounded-3xl border border-m3-outline-subtle bg-m3-surface text-m3-on-surface shadow-m3-3 p-3 sm:p-4 flex flex-col select-none overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header Bar */}
        <div className="flex items-center justify-between pb-2 mb-2 border-b border-m3-outline-subtle/50 shrink-0">
          <div className="flex items-center gap-3">
            {player.agentIcon ? (
              <img
                src={player.agentIcon}
                alt={player.agentName}
                className="w-9 h-9 rounded-xl object-cover border border-m3-outline-subtle shadow-m3-1"
              />
            ) : (
              <div className="w-9 h-9 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle flex items-center justify-center shadow-m3-1">
                <User className="w-4 h-4 text-m3-outline" />
              </div>
            )}
            <div className="flex flex-col">
              <span className="font-display font-bold text-sm sm:text-base text-m3-on-surface tracking-tight leading-tight">
                {rioId}
              </span>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle/60 text-[10px] font-medium text-m3-on-surface-variant">
                  {player.agentName || 'Agent'}
                </span>
                {player.rank && (
                  <span className="px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle/60 text-[10px] font-medium text-m3-primary">
                    {player.rank}
                  </span>
                )}
                {player.accountLevel && (
                  <span className="px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle/60 text-[10px] font-mono text-m3-outline">
                    Lvl {player.accountLevel}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <span className="px-2.5 py-0.5 rounded-full bg-m3-primary-container/30 border border-m3-primary/30 text-[10.5px] font-display font-bold uppercase tracking-[0.2em] text-m3-primary">
              Collection
            </span>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full text-m3-on-surface-variant hover:text-m3-on-surface hover:bg-m3-surface-container-highest transition-colors cursor-pointer"
              aria-label="Close loadout"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Notice banners */}
        {ambiguous && (
          <div className="mb-2 px-3 py-1.5 rounded-xl bg-m3-tertiary-container/30 border border-m3-tertiary/40 text-m3-on-tertiary-container text-xs font-medium flex items-center gap-2 shadow-sm shrink-0">
            <div className="w-1.5 h-1.5 rounded-full bg-m3-tertiary shrink-0 animate-pulse" />
            <span>Multiple players picked {player.agentName} in this match — displaying the first matching loadout.</span>
          </div>
        )}
        {unavailableReason && (
          <div className="mb-2 px-3 py-1.5 rounded-xl bg-m3-surface-container-high border border-m3-outline-subtle text-m3-on-surface-variant text-xs flex items-center gap-2 shrink-0">
            <span>{unavailableReason}</span>
          </div>
        )}

        {/* 5-Column Modular Grid (4 Weapon columns + Player Card & Expressions) */}
        {/* When Riot returns no loadout (e.g. agent select before the server
            ships loadouts), show an honest empty state — never a grid of
            fake "Standard" defaults that reads as real data. */}
        <div className="flex-1 min-h-0 relative overflow-hidden">
          {loading && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-m3-surface/90 backdrop-blur-xs rounded-2xl">
              <Loader2 className="w-6 h-6 text-m3-primary animate-spin" />
              <span className="text-xs font-mono text-m3-primary uppercase tracking-wider">
                Loading live weapon arsenal…
              </span>
            </div>
          )}

          {loadout ? (
            <div className="grid grid-cols-5 gap-2.5 sm:gap-3 items-stretch h-full min-h-0">
          {/* Column 1: SIDEARMS (5 live weapons) */}
            <div className="h-full min-h-0 flex flex-col min-w-0">
              <CategoryHeader title="SIDEARMS" className="mb-1.5 shrink-0" />
              <div className="flex-1 min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.CLASSIC)} />
                <WeaponCard slot={getSlot(SLOTS.SHORTY)} />
                <WeaponCard slot={getSlot(SLOTS.FRENZY)} />
                <WeaponCard slot={getSlot(SLOTS.GHOST)} />
                <WeaponCard slot={getSlot(SLOTS.SHERIFF)} />
              </div>
            </div>

            {/* Column 2: SMGS & SHOTGUNS (2 SMGs + 2 Shotguns) */}
            <div className="h-full min-h-0 flex flex-col min-w-0">
              <CategoryHeader title="SMGS" className="mb-1.5 shrink-0" />
              <div className="flex-1 min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.STINGER)} />
                <WeaponCard slot={getSlot(SLOTS.SPECTRE)} />
              </div>
              <CategoryHeader title="SHOTGUNS" className="mt-2 mb-1.5 shrink-0" />
              <div className="flex-1 min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.BUCKY)} />
                <WeaponCard slot={getSlot(SLOTS.JUDGE)} />
              </div>
            </div>

            {/* Column 3: RIFLES & MELEE (4 Rifles + 1 Melee) */}
            <div className="h-full min-h-0 flex flex-col min-w-0">
              <CategoryHeader title="RIFLES" className="mb-1.5 shrink-0" />
              <div className="flex-[4] min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.BULLDOG)} />
                <WeaponCard slot={getSlot(SLOTS.GUARDIAN)} />
                <WeaponCard slot={getSlot(SLOTS.PHANTOM)} />
                <WeaponCard slot={getSlot(SLOTS.VANDAL)} />
              </div>
              <CategoryHeader title="MELEE" className="mt-2 mb-1.5 shrink-0" />
              <div className="flex-[1] min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.MELEE)} />
              </div>
            </div>

            {/* Column 4: SNIPER RIFLES & MACHINE GUNS (3 Snipers + 2 Heavies) */}
            <div className="h-full min-h-0 flex flex-col min-w-0">
              <CategoryHeader title="SNIPER RIFLES" className="mb-1.5 shrink-0" />
              <div className="flex-[3] min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.MARSHAL)} />
                <WeaponCard slot={getSlot(SLOTS.OUTLAW)} />
                <WeaponCard slot={getSlot(SLOTS.OPERATOR)} />
              </div>
              <CategoryHeader title="MACHINE GUNS" className="mt-2 mb-1.5 shrink-0" />
              <div className="flex-[2] min-h-0 flex flex-col gap-1.5">
                <WeaponCard slot={getSlot(SLOTS.ARES)} />
                <WeaponCard slot={getSlot(SLOTS.ODIN)} />
              </div>
            </div>

            {/* Column 5: PLAYER CARDS & EXPRESSIONS */}
            <div className="h-full min-h-0 flex flex-col min-w-0 items-center">
              <CategoryHeader title="PLAYER CARDS" className="w-full mb-1.5 shrink-0" />
              <div className="flex-1 min-h-0 w-full flex flex-col items-center justify-between gap-2">
                {/* Top: Player Card */}
                <PlayerCardContainer
                  player={player}
                  cardSrc={cardSrc}
                  onImgError={() => setCardImgFailed(true)}
                />

                {/* Bottom: Expressions (Sprays & Flex) */}
                <div className="w-full flex flex-col items-center shrink-0">
                  <CategoryHeader title="EXPRESSIONS" className="w-full mb-1 shrink-0" />
                  <ExpressionsWheel items={loadout?.expressions ?? []} />
                </div>
              </div>
            </div>
            </div>
            ) : (
              !loading && (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
                  <Crosshair className="w-8 h-8 text-m3-outline/40" />
                  <p className="text-sm font-display font-bold text-m3-on-surface">No loadout data</p>
                  <p className="text-xs text-m3-outline max-w-sm leading-relaxed">
                    {unavailableReason ?? 'Riot returned no loadout data for this match yet.'}
                  </p>
                </div>
              )
            )}
        </div>
      </div>
    </div>
  );
};
