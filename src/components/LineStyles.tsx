import React from 'react';
import type { LineStyle } from '../types';

/** The line styles, in the pickers' order (drawn by strokeRenderer.ts `dashPattern`). */
export const LINE_STYLES: { id: LineStyle; label: string; dash?: string }[] = [
  { id: 'solid', label: 'Solid' },
  { id: 'dashed', label: 'Dashed', dash: '5 4' },
  { id: 'longdash', label: 'Long dashes', dash: '9 4' },
  { id: 'dotted', label: 'Dotted', dash: '0.1 4.5' },
  { id: 'dashdot', label: 'Dash-dot', dash: '5 3.5 0.1 3.5' },
];

/** A line style's sample line. */
export const LineStyleIcon: React.FC<{ style: LineStyle; width?: number }> = ({ style, width = 26 }) => {
  const dash = LINE_STYLES.find((l) => l.id === style)?.dash;
  return (
    <svg width={width} height="22" viewBox={`0 0 ${width} 22`} aria-hidden="true">
      <line x1="3" y1="11" x2={width - 3} y2="11" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  );
};

/** The row of line styles in a tool's options (pen, Draw tool). */
export const LineStylePicker: React.FC<{ value: LineStyle; onChange: (ls: LineStyle) => void }> = ({ value, onChange }) => (
  <div className="grid grid-cols-5 gap-1 mb-2" role="radiogroup" aria-label="Line style">
    {LINE_STYLES.map((l) => (
      <button
        key={l.id}
        role="radio"
        aria-checked={value === l.id}
        onClick={() => onChange(l.id)}
        title={l.label}
        aria-label={l.label}
        className={`h-11 rounded-xl border flex items-center justify-center ${value === l.id ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' : 'border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300'}`}
      >
        <LineStyleIcon style={l.id} />
      </button>
    ))}
  </div>
);
