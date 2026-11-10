import React from 'react';
import { MatchDetailBody, type MatchDetailBodyProps } from './matches/MatchDetailBody';

export type MatchDetailModalProps = MatchDetailBodyProps;

/** Dialog chrome around the match body: backdrop, card, sizing. The body itself
 *  lives in `matches/MatchDetailBody` so the Matches ledger can host the same
 *  content in place instead of in a dialog. */
export const MatchDetailModal: React.FC<MatchDetailModalProps> = (props) => {
  if (!props.isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
      <div className="absolute inset-0 bg-black/80" onClick={props.onClose} />
      <div className="relative w-full max-w-[96vw] h-[94vh] max-h-[94vh] bg-m3-surface-container-low border border-m3-outline-subtle rounded-3xl shadow-m3-3 flex flex-col overflow-hidden text-m3-on-surface z-10">
        <MatchDetailBody {...props} />
      </div>
    </div>
  );
};
