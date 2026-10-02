import React from 'react';
import ReactDOM from 'react-dom/client';
import DownloadPage from '../pages/download';
import { useRelease } from './release';
import '../index.css';

function DownloadEntry() {
  const release = useRelease();
  return <DownloadPage version={release.version} downloadUrl={release.downloadUrl} size={release.size} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DownloadEntry />
  </React.StrictMode>
);
