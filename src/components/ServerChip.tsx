import type { FC } from 'react';
import { Globe } from 'lucide-react';

/* Shared match-server chip — reuses the existing status-strip pill language
 * (rounded-full, mono, m3 container/border) on the Live Match page, the
 * Agent Select HUD widget, and the in-game HUD widget. Renders nothing when
 * there is no server (menus / no match). */
export const ServerChip: FC<{ serverName?: string }> = ({ serverName }) => {
  if (!serverName) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-m3-surface-container-high border border-m3-outline-subtle text-[10px] font-mono font-bold text-m3-on-surface-variant shrink-0"
      title={`Match server: ${serverName}`}
    >
      <Globe className="w-3 h-3 text-m3-mint" />
      <span>{serverName}</span>
    </span>
  );
};
