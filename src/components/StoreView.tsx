import React from 'react';
import { StorePanel } from './StorePanel';

/* Full-page Store tab — the account's daily shop, live from Riot.
 * Same panel component as anywhere else, given room to breathe. */
export const StoreView: React.FC = () => {
  return (
    <div className="h-full min-h-0 overflow-y-auto custom-scrollbar">
      <div className="w-full px-4 sm:px-6 pt-3 pb-6">
        <StorePanel />
      </div>
    </div>
  );
};
