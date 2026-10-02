import React from 'react';
import ReactDOM from 'react-dom/client';
import TrackerPage from '../pages/tracker';
import { useRelease } from './release';
import '../index.css';

function TrackerEntry() {
  const release = useRelease();
  return <TrackerPage version={release.version} downloadUrl={release.downloadUrl} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TrackerEntry />
  </React.StrictMode>
);
