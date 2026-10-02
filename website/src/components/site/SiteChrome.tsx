import React from 'react';
import { Download, ExternalLink } from 'lucide-react';

/* ------------------------------------------------------------------ */
/* Shared constants for the marketing sub-pages.                      */
/* These mirror App.tsx so every page reads as one site.                */
/* ------------------------------------------------------------------ */

export const GITHUB_REPO_URL = 'https://github.com/youssefvdel/Recon';
export const KOFI_URL = 'https://ko-fi.com/youssefvdel';
export const SITE_URL = 'https://reconlab.app';

/** Fallback badge text when a page is rendered without a release prop. */
export const DEFAULT_VERSION = 'v0.4.1';

/**
 * Never point a "Download" button at a hardcoded asset URL. When the caller
 * has not resolved a release yet, fall back to the releases page so the button
 * can never be a dead link.
 */
export function resolveDownloadHref(downloadUrl?: string): string {
  const trimmed = downloadUrl?.trim();
  return trimmed ? trimmed : `${GITHUB_REPO_URL}/releases/latest`;
}

export type PageId = 'home' | 'tracker' | 'stretch' | 'download';

const NAV_ITEMS: { id: PageId; label: string; href: string }[] = [
  { id: 'home', label: 'Home', href: '/' },
  { id: 'tracker', label: 'Tracker', href: '/tracker/' },
  { id: 'stretch', label: 'Stretch', href: '/stretch/' },
  { id: 'download', label: 'Download', href: '/download/' },
];

const GithubIcon = ({ className = 'w-4 h-4' }: { className?: string }) => (
  <svg className={className} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
    />
  </svg>
);

/* ------------------------------------------------------------------ */
/* Header                                                              */
/* ------------------------------------------------------------------ */

export interface SiteHeaderProps {
  version?: string;
  downloadUrl?: string;
  active?: PageId;
}

export function SiteHeader({ version = DEFAULT_VERSION, downloadUrl, active }: SiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 backdrop-blur-xl bg-[#09060d]/85 border-b border-white/[0.07]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        <a href="/" className="flex items-center gap-3 group min-w-0">
          <div className="relative w-9 h-9 shrink-0 rounded-xl bg-[#140e1b] border border-[#b6abf7]/30 flex items-center justify-center p-1.5 shadow-md group-hover:border-[#b6abf7] transition-colors">
            <img src="/icon.png" alt="" aria-hidden="true" className="w-full h-full object-contain" />
          </div>
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-display font-black text-lg tracking-wider text-white">RECON</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono font-bold bg-[#261738] text-[#b6abf7] border border-[#b6abf7]/40">
                {version}
              </span>
            </div>
            <span className="hidden sm:block text-[9.5px] font-mono text-zinc-400 uppercase tracking-widest leading-none mt-0.5 truncate">
              VALORANT TRACKER &amp; ESPORTS TOOLKIT
            </span>
          </div>
        </a>

        <nav aria-label="Primary" className="hidden md:flex items-center gap-8 text-xs font-mono uppercase tracking-wider text-zinc-400">
          {NAV_ITEMS.filter((item) => item.id !== 'home').map((item) => (
            <a
              key={item.id}
              href={item.href}
              aria-current={active === item.id ? 'page' : undefined}
              className={
                active === item.id
                  ? 'text-white transition-colors'
                  : 'hover:text-white transition-colors'
              }
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <a
            href={`${GITHUB_REPO_URL}/releases/tag/${version}`}
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20 bg-white/[0.02] text-xs font-mono text-zinc-300 hover:text-white transition-colors"
          >
            <GithubIcon className="w-3.5 h-3.5" />
            <span>{version}</span>
          </a>

          <a
            href={resolveDownloadHref(downloadUrl)}
            className="px-4 py-2 rounded-lg bg-[#b6abf7] hover:bg-[#c8c0fa] text-[#1b1721] font-display font-black text-xs uppercase tracking-wider flex items-center gap-2 tap-feedback active:scale-[0.97] shadow-[0_0_20px_rgba(182,171,247,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b6abf7]"
          >
            <Download className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Download .exe</span>
          </a>
        </div>
      </div>

      {/* Compact nav for narrow viewports, so the four pages are never stranded
          behind a hidden desktop menu. Horizontally scrollable, no wrap. */}
      <nav
        aria-label="Primary, compact"
        className="md:hidden border-t border-white/[0.07] no-scrollbar overflow-x-auto"
      >
        <ul className="max-w-7xl mx-auto px-4 sm:px-6 flex items-center gap-6 h-11 text-[11px] font-mono uppercase tracking-wider text-zinc-400 whitespace-nowrap">
          {NAV_ITEMS.map((item) => (
            <li key={item.id}>
              <a
                href={item.href}
                aria-current={active === item.id ? 'page' : undefined}
                className={
                  active === item.id
                    ? 'text-white'
                    : 'hover:text-white transition-colors'
                }
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Footer                                                              */
/* ------------------------------------------------------------------ */

export function SiteFooter() {
  return (
    <footer className="border-t border-white/[0.08] bg-[#050308] py-10 px-4 sm:px-6 lg:px-8 text-xs font-mono text-zinc-400 z-10">
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img src="/icon.png" alt="" aria-hidden="true" className="w-6 h-6 object-contain opacity-80" />
          <span>RECON // BY YOUSSEF ADEL • ALL RIGHTS RESERVED • SOURCE-AVAILABLE</span>
        </div>

        <div className="flex items-center gap-5">
          <a href={GITHUB_REPO_URL} target="_blank" rel="noreferrer" className="hover:text-zinc-300 transition-colors">
            GITHUB
          </a>
          <a href={KOFI_URL} target="_blank" rel="noreferrer" className="hover:text-amber-300 transition-colors">
            KO-FI
          </a>
          <a href={SITE_URL} className="hover:text-[#b6abf7] transition-colors">
            RECONLAB.APP
          </a>
        </div>
      </div>

      {/* Site nav, so every page is reachable from the footer on mobile too. */}
      <nav aria-label="Footer" className="max-w-7xl mx-auto mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
        {NAV_ITEMS.map((item) => (
          <a key={item.id} href={item.href} className="hover:text-zinc-300 transition-colors uppercase tracking-wider">
            {item.label}
          </a>
        ))}
      </nav>

      <div className="max-w-7xl mx-auto mt-6 pt-4 border-t border-white/5 text-center text-[10px] text-zinc-400">
        Recon is not endorsed by Riot Games and does not reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Valorant is a registered trademark of Riot Games, Inc.
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ */
/* Page shell                                                          */
/* ------------------------------------------------------------------ */

export interface SiteChromeProps {
  version?: string;
  downloadUrl?: string;
  active?: PageId;
  children: React.ReactNode;
}

/**
 * Shared page frame for /tracker/, /stretch/ and /download/. Reproduces the
 * home page's near-black violet canvas, ambient light blobs and top hairline so
 * a sub-page does not feel like a different product.
 */
export function SiteChrome({ version, downloadUrl, active, children }: SiteChromeProps) {
  return (
    <div className="relative min-h-screen bg-[#09060d] text-[#e8def8] selection:bg-[#b6abf7]/30 selection:text-white font-sans antialiased overflow-x-clip flex flex-col">
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -top-32 left-1/2 -translate-x-1/2 w-[900px] h-[450px] bg-gradient-to-b from-[#b6abf7]/10 via-[#f4a390]/5 to-transparent blur-[120px] opacity-70" />
        <div className="absolute top-[35%] right-0 w-[500px] h-[500px] bg-[#3a205a]/20 blur-[150px] opacity-60" />
        <div className="absolute bottom-[10%] left-0 w-[500px] h-[500px] bg-[#1a5238]/15 blur-[160px] opacity-50" />
      </div>

      <div className="fixed top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-[#b6abf7]/50 to-transparent z-50 pointer-events-none" />

      <SiteHeader version={version} downloadUrl={downloadUrl} active={active} />

      <main className="relative z-10 flex-1">{children}</main>

      <SiteFooter />
    </div>
  );
}

export default SiteChrome;