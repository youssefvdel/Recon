import React from 'react';
import score1K from '../assets/badges/score-1k.svg';
import scoreS from '../assets/badges/score-s.svg';
import scoreA from '../assets/badges/score-a.svg';
import scoreB from '../assets/badges/score-b.svg';
import scoreC from '../assets/badges/score-c.svg';
import scoreD from '../assets/badges/score-d.svg';

export type ScoreTier = '1K' | 'S' | 'A' | 'B' | 'C' | 'D';

export const SCORE_TIERS: { tier: ScoreTier; min: number; color: string; dim: string }[] = [
  { tier: '1K', min: 1000, color: '#fedc45', dim: '#925829' },
  { tier: 'S', min: 825, color: '#40c4ff', dim: '#1c5a76' },
  { tier: 'A', min: 650, color: '#3ddc84', dim: '#1d6b41' },
  { tier: 'B', min: 475, color: '#e8b73a', dim: '#7a5c17' },
  { tier: 'C', min: 300, color: '#9fb2c8', dim: '#4a5a6e' },
  { tier: 'D', min: 0, color: '#c98a94', dim: '#6e3f46' },
];

export const scoreTier = (score: number): (typeof SCORE_TIERS)[number] =>
  SCORE_TIERS.find((t) => score >= t.min) ?? SCORE_TIERS[SCORE_TIERS.length - 1];

/** Tier letter → palette hex, so callers don't duplicate the SCORE_TIERS colours. */
export const tierColor = (tier: ScoreTier): string =>
  SCORE_TIERS.find((t) => t.tier === tier)?.color ?? SCORE_TIERS[SCORE_TIERS.length - 1].color;

/** Letter grade from a TRN percentile. Reproduces TRN's observed bands
    (1K = 99th+ percentile / perfect 1000, S≤15% top, A≤35%, B≤50%, C bottom≤25%, else D). */
export const gradeFor = (pct: number): ScoreTier => {
  const top = 100 - pct;
  if (top <= 1) return '1K';
  if (top <= 15) return 'S';
  if (top <= 35) return 'A';
  if (top <= 50) return 'B';
  if (pct >= 25) return 'C';
  return 'D';
};

/** Hex-badge per tier (local assets). */
export const ScoreBadge: React.FC<{ tier: ScoreTier; size?: number }> = ({ tier, size = 64 }) => {
  const src = { '1K': score1K, S: scoreS, A: scoreA, B: scoreB, C: scoreC, D: scoreD }[tier] ?? scoreS;
  return <img src={src} alt={`${tier} tier`} width={size} height={size} className="object-contain shrink-0" />;
};
