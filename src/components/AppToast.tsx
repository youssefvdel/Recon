import React, { useEffect, useRef, useState } from 'react';
import { useTrackerData } from '../hooks/useTrackerData';
import { NoticeToast } from './NoticeToast';

/** Banner text is information, not a layout citizen: it arrives bottom-right,
 *  is read once, and gets out of the board's way. One toast for the whole app,
 *  so every tab behaves the same.
 *
 *  Dedupe is by REASON, not by the whole string: the signed-out copy carries an
 *  age that changes every hour, and re-firing the toast for a new age would be
 *  noise. A new reason replaces the card and restarts its timer; dismissing one
 *  keeps it dismissed until the reason changes. */
function bannerReason(message: string): string {
  const m = message.toLowerCase();
  if (m.startsWith('riot client not signed in')) return 'signed-out';
  if (m.startsWith('riot client is closed')) return 'closed';
  if (m.includes('logged out')) return 'locked-out';
  if (m.includes('not running')) return 'not-running';
  if (m.includes('not responding')) return 'crashed';
  return m.slice(0, 48);
}

export const AppToast: React.FC = () => {
  const { banner, setBanner } = useTrackerData();
  const [visible, setVisible] = useState(false);
  const seenReason = useRef<string | null>(null);
  const dismissedReason = useRef<string | null>(null);

  useEffect(() => {
    if (!banner) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(false);
      return;
    }
    const reason = bannerReason(banner);
    if (reason === dismissedReason.current) return;
    if (reason === seenReason.current) return;
    seenReason.current = reason;
    // The toast is a notification: this setter is the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisible(true);
  }, [banner]);

  if (!visible || !banner) return null;
  return (
    <NoticeToast
      key={bannerReason(banner)}
      message={banner}
      onClose={() => {
        dismissedReason.current = bannerReason(banner);
        seenReason.current = null;
        setVisible(false);
        setBanner(null);
      }}
    />
  );
};
