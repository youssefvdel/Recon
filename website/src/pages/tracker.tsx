import React from 'react';
import {
  Search,
  Users,
  Link2,
  EyeOff,
  Target,
  Crosshair,
  History,
  Layers,
  LayoutGrid,
  Map as MapIcon,
  MousePointerClick,
  Palette,
} from 'lucide-react';
import { SiteChrome } from '../components/site/SiteChrome';
import {
  PageHero,
  Section,
  Shot,
  FeatureGrid,
  Feature,
  StatStrip,
  SpecList,
  Callout,
  Steps,
  CtaBand,
  Rule,
  MICRO,
} from '../components/site/parts';

export interface TrackerPageProps {
  version?: string;
  downloadUrl?: string;
}

const AGENTS = [
  { id: 'jett', name: 'Jett' },
  { id: 'omen', name: 'Omen' },
  { id: 'reyna', name: 'Reyna' },
  { id: 'sova', name: 'Sova' },
  { id: 'viper', name: 'Viper' },
  { id: 'brimstone', name: 'Brimstone' },
  { id: 'iso', name: 'Iso' },
  { id: 'clove', name: 'Clove' },
];

/* Intrinsic sizes, so every <img> reserves its box. Re-measured from the
   files in public/screenshots — no CLS from late image decode. */
const SHOT = {
  overview: { src: '/screenshots/recon-overview.png', width: 1210, height: 800 },
  live: { src: '/screenshots/live-match.png', width: 1172, height: 638 },
  names: { src: '/screenshots/uncovered-names.png', width: 1196, height: 793 },
  hud: { src: '/screenshots/hud-edit-mode.png', width: 2088, height: 1440 },
  loadout: { src: '/screenshots/loadout-viewer.png', width: 1178, height: 771 },
  arsenal: { src: '/screenshots/in-game-arsenal.png', width: 2258, height: 1232 },
} as const;

export default function TrackerPage({ version, downloadUrl }: TrackerPageProps) {
  return (
    <SiteChrome version={version} downloadUrl={downloadUrl} active="tracker">
      <PageHero
        eyebrow="VALORANT TRACKER"
        title="Know who is in your lobby before you lock."
        accent="Ten players, ranked."
        lede={
          <>
            Recon reads the lobby while you queue, then keeps a running record of every match you play. Ranks,
            win rates, the agents you lean on, and the skins other people actually run.
          </>
        }
      >
        <StatStrip
          items={[
            { label: 'Lobby read', value: '10 players', tone: 'accent' },
            { label: 'Data source', value: 'Official local client' },
            { label: 'Extra lag added', value: 'None', tone: 'mint' },
            { label: 'Game state', value: 'Read-only' },
          ]}
        />
      </PageHero>

      <Rule label="Player overview" />

      {/* ---------------------------------------------------------------- */}
      <Section
        id="overview"
        eyebrow="Player overview"
        title="Everything one player has done, on one screen."
        lede="Open a player and you get the whole picture instead of a name and a guess."
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <Shot
              src={SHOT.overview.src}
              alt="The Recon player overview screen, showing a player's rank, rank points and recent form."
              width={SHOT.overview.width}
              height={SHOT.overview.height}
              caption="PLAYER OVERVIEW"
              eager
            />
          </div>
          <div className="lg:col-span-2">
            <SpecList
              rows={[
                { label: 'Rank', value: 'Competitive tier + rank points' },
                { label: 'Win rate', value: 'Last 10, 20 and 50 matches' },
                { label: 'K / D / A', value: 'Per match and per map' },
                { label: 'Headshot %', value: 'Aim tell, split by map' },
                { label: 'Body map', value: 'Head, body and leg kills' },
                { label: 'Peak rank', value: 'Highest tier ever reached' },
              ]}
            />
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="live-match"
        eyebrow="Live match"
        title="Scout the lobby before the agent select timer runs out."
        lede="Ten players with their ranks, the parties they queued in, and a flag on anyone hiding behind incognito."
      >
        <FeatureGrid cols={4}>
          <Feature
            icon={<Users className="w-5 h-5" />}
            title="Ten at once"
            body="Every slot in the lobby, ranked side by side so you can read the lobby at a glance."
          />
          <Feature
            icon={<Link2 className="w-5 h-5" />}
            title="Party detection"
            body="Queued together, marked together. A five-stack stops looking like five strangers."
          />
          <Feature
            icon={<EyeOff className="w-5 h-5" />}
            title="Incognito flags"
            body="Players in incognito are called out, so the empty slot is never a mystery."
          />
          <Feature
            icon={<MousePointerClick className="w-5 h-5" />}
            title="Hover, never lock"
            body="Move over a name for the full card. Selecting a player sends nothing to the game."
          />
        </FeatureGrid>

        <div className="mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Shot
            src={SHOT.live.src}
            alt="The Recon live match panel, listing all ten lobby players with their ranks and party groupings."
            width={SHOT.live.width}
            height={SHOT.live.height}
            caption="LIVE MATCH SCOUTING"
          />
          <Shot
            src={SHOT.names.src}
            alt="Recon showing streamer-mode players whose real names were not shown in the lobby."
            width={SHOT.names.width}
            height={SHOT.names.height}
            caption="UNCOVERED NAMES"
            note="Names come from what the official local client already reports. Nothing is inferred from memory."
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="history"
        eyebrow="Match history"
        title="Your recent matches, with something to do about them."
        lede="A wall of results does not help. Recon sorts your last stretch of games into the three things you can actually change."
      >
        <Steps
          steps={[
            {
              title: 'Where you lose',
              body: 'Every map with your win rate on it. Three losses on the same map in a row is a queue decision, not bad luck.',
            },
            {
              title: 'Which agent to drop',
              body: 'Per-agent win rate next to how often you pick them. Some agents are dragging your record down and you may not have noticed.',
            },
            {
              title: 'Where you die',
              body: 'Deaths plotted on the map, so the flank you keep losing to is visible instead of theoretical.',
            },
          ]}
        />

        <div className="mt-6 sm:mt-8">
          <SpecList
            rows={[
              { label: 'Last match', value: 'Score, K/D/A, agent, map' },
              { label: 'Streaks', value: 'Wins and losses in order' },
              { label: 'Rank movement', value: 'RR gained or lost per game' },
              { label: 'Filters', value: 'By agent, map and queue' },
            ]}
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="stats"
        eyebrow="Per agent, per map"
        title="Split every stat by agent and by map."
        lede="Overall numbers hide the problem. Split them and the pick you should stop making is obvious."
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3 space-y-6">
            <FeatureGrid cols={2}>
              <Feature
                icon={<Crosshair className="w-5 h-5" />}
                title="Agent breakdown"
                body="Win rate, K/D/A and headshot percentage for each agent you play, ranked by how often you pick them."
              />
              <Feature
                icon={<MapIcon className="w-5 h-5" />}
                title="Map breakdown"
                body="The same numbers per map, so you know which map you win and which one you queue anyway."
              />
            </FeatureGrid>

            <div className={MICRO + ' flex items-center gap-2 pt-2'}>
              <History className="w-3.5 h-3.5" />
              <span>Statistics refresh when the next match ends</span>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-2xl border border-white/[0.08] bg-[#120d1a] p-5 sm:p-6">
              <p className={MICRO}>Agent pool</p>
              <ul className="mt-4 grid grid-cols-4 gap-3">
                {AGENTS.map((agent) => (
                  <li key={agent.id} className="text-center">
                    <img
                      src={`/agents/${agent.id}_icon.png`}
                      alt={`${agent.name} icon`}
                      width={1024}
                      height={1024}
                      loading="lazy"
                      decoding="async"
                      className="w-11 h-11 mx-auto rounded-lg object-contain bg-[#1c1325] border border-white/[0.08]"
                    />
                    <span className="mt-1.5 block font-mono text-[10px] text-zinc-400">{agent.name}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[11px] font-mono text-zinc-400 leading-relaxed">
                Every Valorant agent is tracked. These are the eight shown here.
              </p>
            </div>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="overlay"
        eyebrow="In-game overlay"
        title="A HUD that floats over the game and never eats your clicks."
        lede="Small see-through widgets sit on top of VALORANT. While you play they pass every click straight through. Input is only taken when you ask for it."
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <Shot
              src={SHOT.hud.src}
              alt="The Recon HUD in edit mode, laid over a stretched match, with each widget selected for repositioning."
              width={SHOT.hud.width}
              height={SHOT.hud.height}
              caption="HUD EDIT MODE"
              note="Captured at 1.45:1, so this is the same stretched image the overlay is designed for."
            />
          </div>
          <div className="lg:col-span-2">
            <FeatureGrid cols={1}>
              <Feature
                icon={<MousePointerClick className="w-5 h-5" />}
                title="Click-through"
                body="The overlay is invisible to input while you play. It does not sit between you and a firefight."
              />
              <Feature
                icon={<LayoutGrid className="w-5 h-5" />}
                title="Edit mode"
                body="One toggle makes every widget selectable so you can move and resize it, then it goes back to pass-through."
              />
              <Feature
                icon={<Layers className="w-5 h-5" />}
                title="Composed on the GPU"
                body="DirectComposition, so the overlay renders on its own layer and costs no extra input delay."
              />
            </FeatureGrid>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="loadout"
        eyebrow="Loadout viewer"
        title="See the skins your lobby is actually running."
        lede="Pull up any player's arsenal: the agents they play, and the weapon skins they own, exactly as they appear in game."
      >
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Shot
            src={SHOT.loadout.src}
            alt="The Recon loadout viewer showing a player's owned weapon skins and the agents they use."
            width={SHOT.loadout.width}
            height={SHOT.loadout.height}
            caption="LOADOUT VIEWER"
          />
          <Shot
            src={SHOT.arsenal.src}
            alt="An in-game arsenal screen showing the full skin collection for a weapon."
            width={SHOT.arsenal.width}
            height={SHOT.arsenal.height}
            caption="IN-GAME ARSENAL"
          />
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section id="limits" eyebrow="Straight answers">
        <Callout title="What Recon will not tell you">
          <p>
            <strong className="text-white font-semibold">There is no hidden MMR.</strong> Riot does not expose it, so
            any product claiming to know your real rank is making it up. Recon shows the competitive rank Riot actually
            reports, and nothing else.
          </p>
          <p>
            <strong className="text-white font-semibold">Nothing is injected and nothing is read from memory.</strong>{' '}
            Recon only uses the local client API that already ships with the game.
          </p>
          <p>
            <strong className="text-white font-semibold">Hovering a player changes nothing.</strong> Inspecting a
            lobby entry never locks it, sends a packet, or touches the running match.
          </p>
        </Callout>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="who-it-is-for"
        eyebrow="Built for"
        title="Made for the two minutes before you lock."
      >
        <FeatureGrid cols={3}>
          <Feature
            icon={<Target className="w-5 h-5" />}
            title="Scouting a lobby"
            body="You want to know whether the Immortal on your team is actually the Immortal before you commit."
          />
          <Feature
            icon={<Search className="w-5 h-5" />}
            title="Reviewing your own games"
            body="You lost three in a row and want to know which map and which agent did it."
          />
          <Feature
            icon={<Palette className="w-5 h-5" />}
            title="Chasing skins"
            body="You want to see whether the knife you have been saving is worth the next case."
          />
        </FeatureGrid>
      </Section>

      <CtaBand
        version={version}
        downloadUrl={downloadUrl}
        title="Point it at your own lobby."
        body="One installer, no key, no account. It reads the local client and gets out of the way."
        footnote="Read-only · Official local client API only · Nothing sent to Riot"
      />
    </SiteChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Head tags — the page owner injects these per URL.                    */
/* ------------------------------------------------------------------ */

const TITLE = 'Valorant Tracker — Lobby Scouting, Match History & Loadouts | Recon';
const DESCRIPTION =
  'Recon reads your VALORANT lobby live: ten ranked players, party detection and incognito flags. Keeps match history, per-agent and per-map stats, and a click-through HUD overlay with a full loadout viewer.';

export const seo = {
  title: TITLE,
  description: DESCRIPTION,
  canonical: 'https://reconlab.app/tracker/',
  ogImage: 'https://reconlab.app/screenshots/live-match.png',
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: TITLE,
    description: DESCRIPTION,
    url: 'https://reconlab.app/tracker/',
    isPartOf: {
      '@type': 'WebSite',
      name: 'Recon',
      url: 'https://reconlab.app/',
    },
    about: {
      '@type': 'SoftwareApplication',
      name: 'Recon',
      applicationCategory: 'GameApplication',
      operatingSystem: 'Windows 10, Windows 11',
    },
  },
};