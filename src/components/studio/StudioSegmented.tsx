import React from 'react';
import { haptic } from '../../platform';

export interface SegmentOption<T extends string | number> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  title?: string;
}

export interface StudioSegmentedProps<T extends string | number> {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}

export function StudioSegmented<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  className = '',
}: StudioSegmentedProps<T>) {
  const select = (id: T) => {
    if (id !== value) {
      haptic('light');
      onChange(id);
    }
  };

  const containerSizes = {
    sm: 'p-0.5 rounded-xl text-xs',
    md: 'p-1 rounded-2xl text-sm',
  }[size];

  const buttonSizes = {
    sm: 'py-1 px-2.5 rounded-lg gap-1.5',
    md: 'py-1.5 px-3 rounded-xl gap-2',
  }[size];

  return (
    <div
      className={`inline-flex items-center bg-gray-100/90 dark:bg-ui-high/80 backdrop-blur-sm border border-black/5 dark:border-white/5 ${containerSizes} ${className}`}
    >
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={String(opt.id)}
            type="button"
            title={opt.title}
            onClick={() => select(opt.id)}
            className={`flex-1 flex items-center justify-center font-medium transition-all duration-150 select-none ${buttonSizes} ${
              active
                ? 'bg-white dark:bg-ui-panel text-gray-900 dark:text-gray-100 shadow-sm font-semibold'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            {opt.icon && <span className="flex-shrink-0">{opt.icon}</span>}
            <span className="truncate">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
