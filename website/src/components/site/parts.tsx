import React from 'react';
import { Download, ExternalLink } from 'lucide-react';
import {
  GITHUB_REPO_URL,
  resolveDownloadHref,
} from './SiteChrome';

/* ------------------------------------------------------------------ */
/* Design tokens, mirroring the home page.                             */
/*                                                                     */
/* Contrast floor for any text on these surfaces is 4.5:1. The panel    */
/* colour #120d1a is used OPAQUELY (no alpha) precisely so the ratio can */
/* be computed against a known backdrop rather than whatever shows       */
/* through it: zinc-400 lands at 7.2:1, zinc-300 at 12.7:1, #b6abf7 at */
/* 9.1:1, #a8f5cc at 15.9:1, #cfc6ff at 12.9:1.                        */
/* ------------------------------------------------------------------ */

export const PANEL = 'rounded-2xl border border-white/[0.08] bg-[#120d1a]';
export const PANEL_DEEP = 'rounded-2xl border border-white/[0.08] bg-[#0e0914]';
export const EYEBROW = 'font-mono text-[11px] uppercase tracking-[0.2em] font-bold text-[#cfc6ff]';
export const MICRO = 'font-mono text-[10px] uppercase tracking-widest text-zinc-400';
export const LEDE = 'text-base sm:text-lg text-zinc-300 leading-relaxed';

/* ------------------------------------------------------------------ */
/* Page hero                                                           */
/* ------------------------------------------------------------------ */

export interface PageHeroProps {
  eyebrow: string;
  title: React.ReactNode;
  /** Rendered after the title on its own line, in the accent violet. */
  accent?: React.ReactNode;
  lede: React.ReactNode;
  children?: React.ReactNode;
}

export function PageHero({ eyebrow, title, accent, lede, children }: PageHeroProps) {
  return (
    <section className="relative pt-14 sm:pt-20 pb-10 sm:pb-14 text-center overflow-hidden">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <p className={EYEBROW}>{eyebrow}</p>

        <h1 className="hero-title-enter font-display font-medium text-4xl sm:text-5xl lg:text-6xl tracking-tight text-white max-w-4xl mx-auto leading-[1.08] text-balance mt-4">
          {title}
          {accent ? (
            <>
              <br />
              <span className="text-[#b6abf7]">{accent}</span>
            </>
          ) : null}
        </h1>

        <div className="hero-sub-enter mt-6 max-w-2xl mx-auto">
          <p className={LEDE + ' mx-auto'}>{lede}</p>
          {children}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export interface SectionProps {
  id?: string;
  eyebrow?: string;
  title?: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Section({ id, eyebrow, title, lede, children, className = '' }: SectionProps) {
  return (
    <section id={id} className={`py-14 sm:py-20 ${className}`}>
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {(eyebrow || title) && (
          <div className="max-w-3xl">
            {eyebrow ? <p className={EYEBROW}>{eyebrow}</p> : null}
            {title ? (
              <h2 className="font-display font-medium text-2xl sm:text-3xl lg:text-4xl tracking-tight text-white text-balance mt-3">
                {title}
              </h2>
            ) : null}
            {lede ? <p className={LEDE + ' mt-4'}>{lede}</p> : null}
          </div>
        )}
        <div className="mt-8 sm:mt-10">{children}</div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Screenshot figure                                                   */
/* ------------------------------------------------------------------ */

export interface ShotProps {
  src: string;
  alt: string;
  /** Intrinsic pixel size. Always pass these: the width/height attributes are
   *  what reserve the box, so the image never pushes the page down on load. */
  width: number;
  height: number;
  caption?: string;
  className?: string;
  /** Optional note rendered under the caption, e.g. a verification caveat. */
  note?: string;
  eager?: boolean;
}

export function Shot({ src, alt, width, height, caption, note, className = '', eager = false }: ShotProps) {
  return (
    <figure className={PANEL_DEEP + ' overflow-hidden p-2 sm:p-3' + (className ? ' ' + className : '')}>
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        className="w-full h-auto rounded-lg bg-[#07040a]"
      />
      {caption || note ? (
        <figcaption className="px-2 pt-3 pb-1 sm:px-3">
          {caption ? <span className={MICRO + ' block'}>{caption}</span> : null}
          {note ? <span className="mt-2 block text-[11px] font-mono text-zinc-400 leading-relaxed">{note}</span> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Feature grid                                                        */
/* ------------------------------------------------------------------ */

export function FeatureGrid({ children, cols = 3 }: { children: React.ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const cls =
    cols === 1
      ? ''
      : cols === 2
        ? 'sm:grid-cols-2'
        : cols === 4
          ? 'sm:grid-cols-2 lg:grid-cols-4'
          : 'sm:grid-cols-2 lg:grid-cols-3';
  return <div className={`grid grid-cols-1 ${cls} gap-3 sm:gap-4`}>{children}</div>;
}

export interface FeatureProps {
  icon?: React.ReactNode;
  title: string;
  body: React.ReactNode;
  meta?: string;
}

export function Feature({ icon, title, body, meta }: FeatureProps) {
  return (
    <div className={PANEL + ' p-5 sm:p-6'}>
      {icon ? (
        <div className="w-10 h-10 rounded-xl bg-[#1c1325] border border-[#b6abf7]/25 flex items-center justify-center text-[#b6abf7]">
          {icon}
        </div>
      ) : null}
      <h3 className="mt-4 font-display font-semibold text-base text-white">{title}</h3>
      <p className="mt-2 text-sm text-zinc-300 leading-relaxed">{body}</p>
      {meta ? <p className={MICRO + ' mt-3'}>{meta}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stat strip                                                          */
/* ------------------------------------------------------------------ */

export interface StatItem {
  label: string;
  value: string;
  tone?: 'accent' | 'mint' | 'plain';
}

export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
      {items.map((item) => (
        <div key={item.label} className="p-4 rounded-xl border border-white/[0.08] bg-[#120d1a]/70">
          <dt className={MICRO}>{item.label}</dt>
          <dd
            className={
              'mt-1.5 font-mono font-bold text-sm ' +
              (item.tone === 'accent' ? 'text-[#b6abf7]' : item.tone === 'mint' ? 'text-[#a8f5cc]' : 'text-white')
            }
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* Spec list                                                           */
/* ------------------------------------------------------------------ */

export interface SpecRow {
  label: string;
  value: React.ReactNode;
  note?: string;
}

export function SpecList({ rows }: { rows: SpecRow[] }) {
  return (
    <dl className={PANEL + ' divide-y divide-white/[0.06]'}>
      {rows.map((row) => (
        <div
          key={row.label}
          className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 sm:gap-6"
        >
          <dt className={MICRO + ' sm:shrink-0'}>{row.label}</dt>
          <dd className="text-sm font-mono text-zinc-200 sm:text-right">
            {row.value}
            {row.note ? <span className="block mt-1 text-[11px] font-sans text-zinc-400">{row.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* Callout — for the honest limitations / safety notes                 */
/* ------------------------------------------------------------------ */

export function Callout({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'warn' | 'good';
  title: string;
  children: React.ReactNode;
}) {
  const border =
    tone === 'warn' ? 'border-[#f4a390]/30' : tone === 'good' ? 'border-[#a8f5cc]/30' : 'border-white/[0.08]';
  const label = tone === 'warn' ? 'text-[#f4a390]' : tone === 'good' ? 'text-[#a8f5cc]' : 'text-[#cfc6ff]';
  return (
    <div className={`rounded-2xl border ${border} bg-[#120d1a] p-5 sm:p-7`}>
      <p className={`font-mono text-[11px] uppercase tracking-[0.2em] font-bold ${label}`}>{title}</p>
      <div className="mt-3 text-sm text-zinc-300 leading-relaxed space-y-2">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Numbered steps                                                      */
/* ------------------------------------------------------------------ */

export function Steps({ steps }: { steps: { title: string; body: React.ReactNode }[] }) {
  return (
    <ol className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
      {steps.map((step, i) => (
        <li key={step.title} className={PANEL + ' p-5 sm:p-6 relative'}>
          <span className="font-mono text-[11px] font-bold text-[#b6abf7] tracking-widest">
            {String(i + 1).padStart(2, '0')}
          </span>
          <h3 className="mt-3 font-display font-semibold text-base text-white">{step.title}</h3>
          <p className="mt-2 text-sm text-zinc-300 leading-relaxed">{step.body}</p>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------------------------ */
/* CTA band                                                            */
/* ------------------------------------------------------------------ */

export interface CtaBandProps {
  version?: string;
  downloadUrl?: string;
  title: string;
  body: string;
  /** Extra reassurance line under the buttons, e.g. the ban-safe note. */
  footnote?: string;
}

export function CtaBand({ version, downloadUrl, title, body, footnote }: CtaBandProps) {
  return (
    <section className="py-14 sm:py-20">
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="relative overflow-hidden rounded-3xl border border-[#b6abf7]/25 bg-gradient-to-br from-[#1c1325] via-[#140e1b] to-[#0b0712] px-6 py-12 sm:px-12 sm:py-16 text-center">
          <div
            className="absolute -top-24 left-1/2 -translate-x-1/2 w-[620px] h-[260px] bg-[#b6abf7]/10 blur-[110px] pointer-events-none"
            aria-hidden="true"
          />
          <div className="relative">
            <h2 className="font-display font-medium text-2xl sm:text-3xl lg:text-4xl tracking-tight text-white text-balance">
              {title}
            </h2>
            <p className="mt-4 text-base text-zinc-300 max-w-xl mx-auto leading-relaxed">{body}</p>

            <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3.5">
              <a
                href={resolveDownloadHref(downloadUrl)}
                className="w-full sm:w-auto px-8 py-4 rounded-xl bg-[#b6abf7] hover:bg-[#c8c0fa] text-[#1b1721] font-display font-black text-sm uppercase tracking-wider flex items-center justify-center gap-3 tap-feedback active:scale-[0.97] shadow-[0_0_35px_rgba(182,171,247,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6abf7]"
              >
                <Download className="w-4 h-4 stroke-[2.5]" />
                <span>Download{version ? ` ${version}` : ' Recon'}</span>
              </a>
              <a
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="w-full sm:w-auto px-6 py-4 rounded-xl border border-white/15 hover:border-white/30 bg-white/[0.02] text-sm font-bold text-zinc-200 flex items-center justify-center gap-2 transition-colors tap-feedback active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6abf7]"
              >
                <span>Source Code (Source-Available)</span>
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400" />
              </a>
            </div>

            {footnote ? <p className="mt-6 text-[11px] font-mono text-zinc-400">{footnote}</p> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Divider                                                             */
/* ------------------------------------------------------------------ */

export function Rule({ label }: { label?: string }) {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div className="flex items-center gap-4">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-white/[0.12]" />
        {label ? <span className={MICRO}>{label}</span> : null}
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-white/[0.12]" />
      </div>
    </div>
  );
}

export default Rule;