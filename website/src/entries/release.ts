import { useEffect, useState } from 'react';

/* Latest-release resolution for the sub-page entries.
 *
 * Same pattern as the home page (website/src/App.tsx): ask the GitHub REST
 * API for the latest release — the API sends permissive CORS headers, while
 * direct release-asset downloads never send `Access-Control-Allow-Origin` —
 * then take the first `.exe` asset. The caller falls back to the releases
 * page when no asset resolved, so a Download button is never a dead link. */

export interface ReleaseInfo {
  version: string;
  downloadUrl: string;
  size: string;
}

export const DEFAULT_RELEASE: ReleaseInfo = {
  version: 'v0.3.2',
  downloadUrl: 'https://github.com/youssefvdel/Recon/releases/download/v0.3.2/Recon_0.3.2_x64-setup.exe',
  size: '18 MB',
};

export function useRelease(): ReleaseInfo {
  const [release, setRelease] = useState<ReleaseInfo>(DEFAULT_RELEASE);

  useEffect(() => {
    let isMounted = true;

    async function fetchLatestRelease() {
      try {
        const apiRes = await fetch('https://api.github.com/repos/youssefvdel/Recon/releases/latest');
        if (apiRes.ok) {
          const apiData = await apiRes.json();
          const exeAsset = apiData.assets?.find((a: { name?: string; browser_download_url?: string; size?: number }) =>
            a.name?.endsWith('.exe')
          );
          if (isMounted && exeAsset) {
            const mb = `${Math.round(exeAsset.size / (1024 * 1024))} MB`;
            setRelease((prev) => ({
              version: apiData.tag_name || prev.version,
              downloadUrl: exeAsset.browser_download_url || prev.downloadUrl,
              size: mb,
            }));
          }
        }
      } catch {}
    }

    fetchLatestRelease();
    return () => {
      isMounted = false;
    };
  }, []);

  return release;
}
