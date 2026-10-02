import React from 'react';
import {
  Ruler,
  Maximize2,
  Gauge,
  Undo2,
  FileCog,
  Cpu,
  Target,
  ArrowLeftRight,
  ShieldCheck,
  Layers,
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
} from '../components/site/parts';

export interface StretchPageProps {
  version?: string;
  downloadUrl?: string;
}

/* Intrinsic sizes measured from public/screenshots. */
const SHOT = {
  preview: { src: '/screenshots/stretch-preview-clove.png', width: 1196, height: 793 },
  resolution: { src: '/screenshots/recon-resolution.png', width: 1210, height: 800 },
  config: { src: '/screenshots/recon-game-config.png', width: 1210, height: 800 },
} as const;

export default function StretchPage({ version, downloadUrl }: StretchPageProps) {
  return (
    <SiteChrome version={version} downloadUrl={downloadUrl} active="stretch">
      <PageHero
        eyebrow="TRUE STRETCHED RESOLUTION"
        title="Play wider without losing the aim you trained."
        accent="Targets 22.6% wider."
        lede={
          <>
            VALORANT draws into a 16:9 frame. True stretch draws it at 1.45:1 and lets your display spread the image
            back across the panel, so every character, weapon and crosshair ends up physically wider. Vertical aim is
            untouched, which is why your sensitivity does not need to move.
          </>
        }
      >
        <StatStrip
          items={[
            { label: 'Aspect ratio', value: '1.45:1', tone: 'accent' },
            { label: 'Wider targets', value: '+22.6%' },
            { label: 'Vertical FOV', value: 'Unchanged', tone: 'mint' },
            { label: 'Sensitivity', value: 'Stays put' },
          ]}
        />
      </PageHero>

      <Rule label="What it changes" />

      {/* ---------------------------------------------------------------- */}
      <Section
        id="what-changes"
        eyebrow="The short version"
        title="Wider is not faster."
        lede="Stretch only scales the horizontal axis. What people mean by the aim being untouched is that nothing about your vertical tracking moves."
      >
        <FeatureGrid cols={4}>
          <Feature
            icon={<Maximize2 className="w-5 h-5" />}
            title="Everything gets wider"
            body="Players, guns, barrels, the gap between two cover plates. All of it scales the same 22.6%."
          />
          <Feature
            icon={<Ruler className="w-5 h-5" />}
            title="Vertical stays the same"
            body="High ground, jumps and long angles feel exactly as they did at 16:9."
          />
          <Feature
            icon={<Target className="w-5 h-5" />}
            title="Crosshair sits still"
            body="The crosshair stays on the pixel you aimed at. Only the model around it got wider."
          />
          <Feature
            icon={<Gauge className="w-5 h-5" />}
            title="No added input delay"
            body="It is a resolution change, not a scaling hack. Nothing sits in the input path."
          />
        </FeatureGrid>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="preview"
        eyebrow="Preview first"
        title="See the stretch before you play a round in it."
        lede="Recon renders the preview with the same geometry the game will use, so what you see on this page is what lands in your lobby."
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <Shot
              src={SHOT.preview.src}
              alt="Clove rendered at stretched resolution, showing the wider character model and weapon geometry."
              width={SHOT.preview.width}
              height={SHOT.preview.height}
              caption="STRETCH PREVIEW · CLOVE"
              eager
            />
          </div>
          <div className="lg:col-span-2">
            <SpecList
              rows={[
                { label: 'Rendered at', value: '1.45:1' },
                { label: 'Displayed at', value: 'Your panel, 16:9' },
                { label: 'Horizontal scale', value: '+22.6%' },
                { label: 'Vertical scale', value: '1.00 (none)' },
                { label: 'Sensitivity change', value: 'None' },
                { label: 'Input lag added', value: 'None' },
              ]}
            />
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="apply"
        eyebrow="Apply"
        title="One click, and it puts the game back if anything goes wrong."
        lede="A resolution change that leaves you staring at a black screen is a bad afternoon. Recon applies the change and watches for the result."
      >
        <Steps
          steps={[
            {
              title: 'Pick the ratio',
              body: 'Choose a preset or type any resolution. The wizard shows the resulting ratio before you commit to it.',
            },
            {
              title: 'Recon applies it',
              body: 'The resolution and the borderless switch are set together, so the game comes back at the size you asked for.',
            },
            {
              title: 'Watchdog stands by',
              body: 'If the game does not come back, the watchdog puts the previous resolution and window mode back on its own.',
            },
          ]}
        />

        <div className="mt-6 sm:mt-8 grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <Shot
              src={SHOT.resolution.src}
              alt="The Recon resolution screen listing custom resolutions with their aspect ratio and borderless toggle."
              width={SHOT.resolution.width}
              height={SHOT.resolution.height}
              caption="CUSTOM RESOLUTIONS"
            />
          </div>
          <div className="lg:col-span-2">
            <FeatureGrid cols={1}>
              <Feature
                icon={<ShieldCheck className="w-5 h-5" />}
                title="Safe-mode watchdog"
                body="Your last working resolution and window mode are saved before every change, and restored automatically if the game fails to come back."
              />
              <Feature
                icon={<Layers className="w-5 h-5" />}
                title="Auto-borderless"
                body="Fills the panel with no title bar and no black bars, applied without changing how the game is launched."
              />
            </FeatureGrid>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="sensitivity"
        eyebrow="Sensitivity"
        title="A matcher, so you do not have to guess."
        lede="Stretch does not change your sensitivity. If a tool told you it did, that tool is wrong. The matcher reads what you actually have and shows the equivalent if you ever do change it."
      >
        <FeatureGrid cols={3}>
          <Feature
            icon={<ArrowLeftRight className="w-5 h-5" />}
            title="Reads your current sens"
            body="Pulled from the game config itself, so it is the number VALORANT is actually using."
          />
          <Feature
            icon={<Gauge className="w-5 h-5" />}
            title="Shows the 360 distance"
            body="Centimetres per turn, which is the only sensitivity number that survives a resolution change."
          />
          <Feature
            icon={<Target className="w-5 h-5" />}
            title="Tells you to leave it alone"
            body="If a switch would move your 360 distance, it says so instead of quietly doing it."
          />
        </FeatureGrid>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="gpu"
        eyebrow="Display scaling"
        title="A scaling report that reports what it can actually see."
        lede="Windows and the GPU driver each own a piece of the scaling chain, and they can quietly disagree. Recon reads the state back and tells you which piece is in charge."
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <SpecList
              rows={[
                { label: 'Resolution', value: 'Read from Windows', note: 'Current desktop resolution, confirmed against the display itself' },
                { label: 'Scaling mode', value: 'WDDM, read back', note: 'Stretch or maintain aspect, whichever Windows reports' },
                { label: 'GPU mode', value: 'Full-screen or borderless' },
                { label: 'Refresh rate', value: 'Reported by the panel' },
                { label: 'Rows it cannot confirm', value: 'Marked UNVERIFIED', note: 'Shown as unknown instead of guessed' },
              ]}
            />
          </div>
          <div className="lg:col-span-2">
            <Callout tone="neutral" title="No driver keys, ever">
              <p>
                Recon does not write AMD, Intel or NVIDIA driver keys to force a scaling mode. Those settings have
                caused broken scaling and lost HDMI audio on real machines, so Recon reports the state and leaves the
                decision alone.
              </p>
            </Callout>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        id="config"
        eyebrow="Game config"
        title="Edit the game's own settings from inside Recon."
        lede="Crosshair, sensitivity, video options and keybinds, written to the real VALORANT config with a backup taken first."
      >
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:gap-8 items-start">
          <div className="lg:col-span-3">
            <Shot
              src={SHOT.config.src}
              alt="The Recon VALORANT config editor with crosshair, sensitivity and video settings in one panel."
              width={SHOT.config.width}
              height={SHOT.config.height}
              caption="VALORANT CONFIG EDITOR"
            />
          </div>
          <div className="lg:col-span-2">
            <FeatureGrid cols={1}>
              <Feature
                icon={<FileCog className="w-5 h-5" />}
                title="Writes the real file"
                body="The game's own config, so settings survive a restart and a reinstall of Recon."
              />
              <Feature
                icon={<Undo2 className="w-5 h-5" />}
                title="Backup before every write"
                body="A bad edit is one click to undo, without hunting through config folders."
              />
              <Feature
                icon={<Cpu className="w-5 h-5" />}
                title="Only the game's settings"
                body="No memory writes, no injection, no calls into the running game."
              />
            </FeatureGrid>
          </div>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section id="before-you-apply" eyebrow="Before you apply">
        <Callout tone="warn" title="Read this first">
          <p>
            <strong className="text-white font-semibold">Test in a private match.</strong> A resolution change is easy
            to undo and annoying to discover mid-round.
          </p>
          <p>
            <strong className="text-white font-semibold">If the game does not come back, the watchdog restores.</strong>{' '}
            Your previous resolution and window mode are written down before anything changes.
          </p>
          <p>
            <strong className="text-white font-semibold">Not everything needs a custom resolution.</strong> If your
            display scaling is already handling it, the report will say so and you can leave it alone.
          </p>
        </Callout>
      </Section>

      <CtaBand
        version={version}
        downloadUrl={downloadUrl}
        title="Stretch is one click away."
        body="Install, pick a ratio, and the watchdog covers you if the game disagrees."
        footnote="Saved state before every change · Restored automatically on failure"
      />
    </SiteChrome>
  );
}

/* ------------------------------------------------------------------ */
/* Head tags — the page owner injects these per URL.                    */
/* ------------------------------------------------------------------ */

const TITLE = 'True Stretched Resolution 1.45:1 for VALORANT — One-Click Apply | Recon';
const DESCRIPTION =
  'Stretch VALORANT to 1.45:1 for targets 22.6% wider with your sensitivity untouched. One-click apply with a safe-mode watchdog, auto-borderless, a sensitivity matcher, a GPU scaling report and the VALORANT config editor.';

export const seo = {
  title: TITLE,
  description: DESCRIPTION,
  canonical: 'https://reconlab.app/stretch/',
  ogImage: 'https://reconlab.app/screenshots/stretch-preview-clove.png',
  jsonLd: {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: TITLE,
    description: DESCRIPTION,
    url: 'https://reconlab.app/stretch/',
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