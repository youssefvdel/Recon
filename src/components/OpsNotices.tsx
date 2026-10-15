import React from 'react';
import { Megaphone, TriangleAlert, OctagonAlert, X, ExternalLink } from 'lucide-react';
import type { OpsNotice } from '../utils/ops';
import { dismissNotice } from '../utils/ops';

/* Server-driven broadcast banners (ops/notices.json). Game-style server
 * notices: show, link out, dismiss. Nothing hardcoded. */

const TONE: Record<string, { icon: React.ReactNode; box: string; text: string }> = {
  info: {
    icon: <Megaphone className="w-3.5 h-3.5 shrink-0" />,
    box: 'bg-m3-primary-container/20 border-m3-primary/40',
    text: 'text-m3-on-surface',
  },
  warn: {
    icon: <TriangleAlert className="w-3.5 h-3.5 shrink-0" />,
    box: 'bg-amber-500/10 border-amber-500/40',
    text: 'text-amber-200',
  },
  critical: {
    icon: <OctagonAlert className="w-3.5 h-3.5 shrink-0" />,
    box: 'bg-red-500/10 border-red-500/40',
    text: 'text-red-200',
  },
};

export const OpsNotices: React.FC<{
  notices: OpsNotice[];
  onDismiss: (id: string) => void;
}> = ({ notices, onDismiss }) => {
  if (notices.length === 0) return null;
  return (
    <div className="px-4 sm:px-6 pt-2 space-y-2 shrink-0">
      {notices.map((n) => {
        const tone = TONE[n.severity] ?? TONE.info;
        return (
          <div
            key={n.id}
            className={`rounded-xl border px-3 py-2 flex items-start gap-2.5 ${tone.box}`}
          >
            <span className={tone.text}>{tone.icon}</span>
            <div className="min-w-0 flex-1">
              <div className={`text-[12px] font-bold ${tone.text}`}>{n.title}</div>
              <div className="text-[11px] text-m3-on-surface-variant leading-snug mt-0.5">
                {n.body}
              </div>
              {n.link && (
                <a
                  href={n.link}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-m3-primary hover:underline mt-1"
                >
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
            {n.dismissible !== false && (
              <button
                onClick={() => {
                  dismissNotice(n.id);
                  onDismiss(n.id);
                }}
                aria-label="Dismiss notice"
                className="p-1 rounded-lg text-m3-outline hover:text-m3-on-surface hover:bg-black/20 transition-colors cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
};
