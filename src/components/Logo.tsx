import React, { useId } from 'react';

/**
 * OpenNote's logo: a pen drawing an "O" on a blue-violet tile. The same artwork is in
 * assets-src/logo.svg, from which the favicon, launcher icons and splash screens are rendered.
 */
export const Logo: React.FC<{ size?: number; className?: string }> = ({ size = 32, className }) => {
  const g = `on-logo-${useId().replace(/:/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-label="OpenNote" role="img">
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3B82F6" />
          <stop offset="1" stopColor="#6D28D9" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${g})`} />
      <g fill="#fff" stroke="#fff" strokeLinejoin="round">
        <path d="M41.3 27.4A15 15 0 1 1 34.1 21.9" fill="none" strokeWidth="6.5" strokeLinecap="round" />
        <path d="M42.6 26.4 49.2 24.7 44.3 19.8Z" strokeWidth="1.2" />
        <path d="M50.1 23.9 45.1 18.9 51.5 12.5 56.5 17.5Z" fillOpacity=".85" strokeOpacity=".85" strokeWidth="1.6" />
      </g>
    </svg>
  );
};
