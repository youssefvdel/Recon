import React from 'react';
import ReactDOM from 'react-dom/client';
import StretchPage from '../pages/stretch';
import { useRelease } from './release';
import '../index.css';

function StretchEntry() {
  const release = useRelease();
  return <StretchPage version={release.version} downloadUrl={release.downloadUrl} />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StretchEntry />
  </React.StrictMode>
);
