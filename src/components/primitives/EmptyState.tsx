import React from 'react';

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

/** One empty state: says what is missing, never why the app failed. */
export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, description, action, className = '' }) => (
  <div className={`flex flex-col items-center justify-center gap-2 px-4 py-6 text-center ${className}`}>
    {icon && <div className="text-m3-outline/70">{icon}</div>}
    <p className="font-display text-sm font-bold text-m3-on-surface">{title}</p>
    {description && <p className="max-w-md text-micro leading-relaxed text-m3-outline">{description}</p>}
    {action}
  </div>
);
