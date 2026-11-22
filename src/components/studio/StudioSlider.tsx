import React, { useEffect, useState } from 'react';

export interface StudioSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  log?: boolean;
  unit?: string;
  onChange: (v: number) => void;
}

export const StudioSlider: React.FC<StudioSliderProps> = ({
  label,
  value,
  min,
  max,
  log = true,
  unit = 'px',
  onChange,
}) => {
  const toLevel = (v: number) =>
    Math.round(
      1 +
        99 *
          (log
            ? Math.log(Math.max(min, Math.min(max, v)) / min) / Math.log(max / min)
            : (Math.max(min, Math.min(max, v)) - min) / (max - min))
    );

  const fromLevel = (l: number) =>
    log ? min * Math.pow(max / min, (l - 1) / 99) : min + ((l - 1) / 99) * (max - min);

  const level = toLevel(value);
  const [draft, setDraft] = useState(String(Math.round(value * 10) / 10));

  useEffect(() => {
    setDraft(String(Math.round(value * 10) / 10));
  }, [value]);

  const handleRange = (l: number) => {
    const raw = fromLevel(Math.max(1, Math.min(100, Math.round(l))));
    onChange(Math.round(raw * 10) / 10);
  };

  const handleTextCommit = () => {
    const n = Number(draft);
    if (!isNaN(n) && n >= min && n <= max) {
      onChange(n);
    } else {
      setDraft(String(Math.round(value * 10) / 10));
    }
  };

  return (
    <div className="space-y-1.5 py-1">
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 font-medium">
        <span>{label}</span>
        <span className="tabular-nums font-mono text-[11px] text-gray-700 dark:text-gray-300">
          {Math.round(value * 10) / 10} {unit}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={level}
          onChange={(e) => handleRange(+e.target.value)}
          className="flex-1 h-1.5 bg-gray-200 dark:bg-ui-high rounded-lg appearance-none cursor-pointer accent-studio-accent focus:outline-none"
          aria-label={label}
        />
        <div className="flex items-center bg-gray-100 dark:bg-ui-high rounded-xl border border-black/5 dark:border-white/10 px-2 py-1">
          <input
            type="number"
            inputMode="decimal"
            step="any"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={handleTextCommit}
            onKeyDown={(e) => e.key === 'Enter' && handleTextCommit()}
            className="w-12 text-center text-xs font-mono bg-transparent text-gray-900 dark:text-gray-100 focus:outline-none select-text"
            aria-label={`${label} input`}
          />
          <span className="text-[10px] text-gray-400 select-none">{unit}</span>
        </div>
      </div>
    </div>
  );
};
