import React from 'react';
import {
  Download,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
  Flag,
  Lock,
  FileCode2,
  HardDrive,
  CircleCheck,
} from 'lucide-react';
import {
  SiteChrome,
  GITHUB_REPO_URL,
  KOFI_URL,
  resolveDownloadHref,
  DEFAULT_VERSION,
} from '../components/site/SiteChrome';
import {
  PageHero,
  Section,
  Shot,
  FeatureGrid,
  Feature,
  SpecList,
  Callout,
  CtaBand,
  Rule,
} from '../components/site/parts';

export interface DownloadPageProps {
  version?: string;
  downloadUrl?: string;
  /** Installer size, e.g. "18 MB". Rendered only when provided. */
  size?: string;
}

/* Intrinsic size measured from public/screenshots. */
const SHOT_APP = { src: '/screenshots/recon-real-app.png', width: 1210, height: 800 } as const;

export default function DownloadPage({ version = DEFAULT_VERSION, downloadUrl, size }: DownloadPageProps) {
  const href = resolveDownloadHref(downloadUrl);
  const isDirectAsset = Boolean(downloadUrl && downloadUrl.trim());

  return (
    <SiteChrome version={version} downloadUrl={downloadUrl} active="download">
      <PageHero
        eyebrow="DOWNLOAD"
        title="One installer."
        accent="No key, no account."
        lede={
          <>
            Recon is a single small Windows installer. It reads the VALORANT client you already have, adds a thin
            overlay over the game, and gets out of the way. There is nothing to sign up for and nothing to paste.
          </>
        }
      >
        {/* The one thing this page exists to do, so it gets the biggest target
            on the page and no competing link above it. */}
        <div className="mt-8 mx-auto max-w-xl rounded-2xl border border-[#b6abf7]/30 bg-[#140e1b] p-6 sm:p-7 text-left">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] font-bold text-[#cfc6ff]">
              Latest release
            </span>
            <span className="px-2 py-0.5 rounded text-[11px] font-mono font-bold bg-[#261738] text-[#b6abf7] border border-[#b6abf7]/40">
              {version}
            </span>
            {size ? (
              <span className="font-mono text-[11px] text-zinc-400">{size}</span>
            ) : null}
            <span className="font-mono text-[11px] text-zinc-400">Windows 10 / 11 · x64</span>
          </div>

          <a
            href={href}
            className="mt-5 w-full px-8 py-5 rounded-xl bg-[#b6abf7] hover:bg-[#c8c0fa] text-[#1b1721] font-display font-black text-base uppercase tracking-wider flex items-center justify-center gap-3 tap-feedback active:scale-[0.97] shadow-[0_0_40px_rgba(182,171,247,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6abf7]"
          >
            <Download className="w-5 h-5 stroke-[2.5]" />
            <span>Download Recon {version}</span>
          </a>

          <p className="mt-4 text-[11px] font-mono text-zinc-400 leading-relaxed">
            {isDirectAsset
              ? 'Signed installer. Windows SmartScreen may ask once, the first time, for any unsigned-looking app.'
              : 'Release lookup unavailable — this button goes to the GitHub releases page so it is never a dead link.'}
          </p>

          <div className="mt-5 pt-5 border-t border-white/[0.08] flex flex-wrap items-center gap-x-6 gap-y-2">
            <a
              href={`${GITHUB_REPO_URL}/releases`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-zinc-400 hover:text-white transition-colors"
            >
              <Flag className="w-3.5 h-3.5" />
              <span>Release notes</span>
              <ExternalLink className="w-3 h-3" />
            </a>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-zinc-400 hover:text-white transition-colors"
            >
              <FileCode2 className="w-3.5 h-3.5" />
              <span>Source code</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      </PageHero>

      <Rule label="Requirements" />

      {/* ---------------------------------------------------------------- */}
      <Section id="requirements" eyebrow="Requirements" title="What you need before it installs.">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <SpecList
              rows={[
                { label: 'Operating system', value: 'Windows 10 or 11, 64-bit' },
                { label: 'VALORANT', value: 'Installed and launched at least once' },
                { label: 'Riot Client', value: 'Installed, and logged in' },
                { label: 'Disk', value: 'About 200 MB free', note: 'The installer is around 18 MB' },
                { label: 'Memory', value: 'About 35 MB while running', note: 'Rust and Tauri, no runtime to install' },
                { label: 'Administrator', value: 'Asked once, for display scaling', note: 'Windows keeps scaling settings at system level, so reading and repairing them needs it' },
              ]}
            />
          </div>
          <div className="lg:col-span-2">
            <Shot
              src={SHOT_APP.src}
              alt="The Recon desktop app window, showing its sidebar navigation and overview panel."
              width={SHOT_APP.width}
              height={SHOT_APP.height}
              caption="RECON DESKTOP APP"
              eager
            />
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="updates"
        eyebrow="Updates"
        title="Updates happen on their own, and never mid-match."
        lede="Nobody wants a game restarting because a background task decided now was a good moment."
      >
        <FeatureGrid cols={3}>
          <Feature
            icon={<ShieldCheck className="w-5 h-5" />}
            title="Signed and silent"
            body="Each build is signed, so Windows does not treat an update as an unknown app. No installer window, no click."
          />
          <Feature
            icon={<RefreshCw className="w-5 h-5" />}
            title="Two channels"
            body="Stable for normal play. Early access if you want the next build first and can step back a version."
          />
          <Feature
            icon={<Lock className="w-5 h-5" />}
            title="Waits for your match"
            body="An update only installs when no match is live. Mid-round, it holds until you are out."
          />
        </FeatureGrid>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section id="safety" eyebrow="Vanguard" title="Why this is not a ban risk.">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <div className="space-y-3">
              <div className="rounded-2xl border border-white/[0.08] bg-[#120d1a] p-5 sm:p-6">
                <h3 className="font-display font-semibold text-base text-white">Read-only, start to finish</h3>
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed">
                  Recon reads. It does not write to VALORANT or the Riot Client while a match is running, and it does not
                  change anything about how the game executes.
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.08] bg-[#120d1a] p-5 sm:p-6">
                <h3 className="font-display font-semibold text-base text-white">Official APIs only</h3>
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed">
                  The data comes from the local client API that ships with the game. No memory reads, no injection, no
                  packet hooks, no input automation.
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.08] bg-[#120d1a] p-5 sm:p-6">
                <h3 className="font-display font-semibold text-base text-white">Hovering a player does nothing</h3>
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed">
                  Inspecting a lobby entry is a local read. Locking one would be a different feature, and it is not one
                  Recon has.
                </p>
              </div>
              <div className="rounded-2xl border border-white/[0.08] bg-[#120d1a] p-5 sm:p-6">
                <h3 className="font-display font-semibold text-base text-white">The overlay is click-through</h3>
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed">
                  The in-game HUD passes every click to the game while you play. It only takes input in edit mode, which
                  you have to switch on yourself.
                </p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-2">
            <Callout tone="good" title="No invented numbers">
              <p>
                Recon does not display hidden MMR or any stat Riot does not publish. If a field cannot be read, it is
                left out rather than filled in with an estimate.
              </p>
              <p>
                The same rule applies to display state: anything Recon cannot read back from your machine is labelled{' '}
                <strong className="text-white font-semibold">UNVERIFIED</strong> instead of being reported as fact.
              </p>
            </Callout>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="source"
        eyebrow="Source-available"
        title="Read the code, or build it yourself."
        lede="The repository is on GitHub. Recon is source-available rather than fully open, and the licence terms are in the repository."
      >
        <FeatureGrid cols={3}>
          <Feature
            icon={<FileCode2 className="w-5 h-5" />}
            title="You can read it"
            body="The tracker, the resolver, the overlay and the installer are all in the repository."
          />
          <Feature
            icon={<HardDrive className="w-5 h-5" />}
            title="You can build it"
            body="Rust, Tauri and Bun. Clone it, build it, and it is your build from then on."
          />
          <Feature
            icon={<CircleCheck className="w-5 h-5" />}
            title="No closed binary to trust"
            body="If a claim on this page matters to you, the code that makes it is one click away."
          />
        </FeatureGrid>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section id="questions" eyebrow="Questions" title="The ones people actually ask.">
        <SpecList
          rows={[
            {
              label: 'Will I get banned?',
              value: 'No',
              note: 'Read-only, official local client API, no injection and no memory access.',
            },
            {
              label: 'Do I need an account or a key?',
              value: 'No',
              note: 'There is no sign-up and nothing to enter. Install and open it.',
            },
            {
              label: 'Does it cost anything?',
              value: 'No',
              note: 'Free, including the stretch tools and the overlay.',
            },
            {
              label: 'Will it change my VALORANT config?',
              value: 'Only when you ask',
              note: 'The config editor takes a backup before every write, and the watchdog restores resolution changes on failure.',
            },
            {
              label: 'Can I remove it?',
              value: 'Yes',
              note: 'Normal Windows uninstall, and your VALORANT config backup is left in place for you.',
            },
          ]}
        />
      </Section>

      <CtaBand
        version={version}
        downloadUrl={downloadUrl}
        title="Install it and see the lobby."
        body="The installer is signed, small, and asks for nothing beyond the two things Windows needs to change display settings."
        footnote={`Read-only · Official local client API only · Free, no key (support: ${KOFI_URL})`}
      />
    </SiteChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Head tags — the page owner injects these per URL.                    */
/* ------------------------------------------------------------------ */

const TITLE = 'Download Recon — VALORANT Tracker & True Stretch | Recon';
const DESCRIPTION =
  'Download Recon for Windows: a VALORANT tracker, live lobby scouting, click-through HUD overlay and true 1.45:1 stretched resolution. Signed installer, read-only, no account, no key.';

export const seo = {
  title: TITLE,
  description: DESCRIPTION,
  canonical: 'https://reconlab.app/download/',
  ogImage: 'https://reconlab.app/screenshots/recon-real-app.png',
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: TITLE,
    description: DESCRIPTION,
    url: 'https://reconlab.app/download/',
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
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
  },
};