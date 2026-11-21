import React, { useState } from 'react';
import { Pipette, Plus, Star, X } from 'lucide-react';
import { canPickColour, pickColour } from '../../services/eyedropper';
import { COLOUR_SPHERE, Spectrum, normalizeHex, useFavoriteColors } from '../ColorPicker';
import { haptic } from '../../platform';

export interface StudioColorGridProps {
  value: string;
  onChange: (hex: string) => void;
  presets?: string[];
  size?: 'sm' | 'md';
}

const DEFAULT_PRESETS = [
  '#111827', '#1A73E8', '#D93025', '#188038', '#F2994A', '#9B51E0', '#6B7280', '#00A88A', '#FFFFFF',
];

export const StudioColorGrid: React.FC<StudioColorGridProps> = ({
  value,
  onChange,
  presets = DEFAULT_PRESETS,
  size = 'md',
}) => {
  const [spectrumOpen, setSpectrumOpen] = useState(false);
  const favorites = useFavoriteColors();
  const current = (normalizeHex(value) ?? value).toUpperCase();

  const handleSelect = (color: string) => {
    haptic('light');
    onChange(color);
  };

  const swatchSizes = size === 'sm' ? 'w-6 h-6' : 'w-7 h-7';

  return (
    <div className="space-y-3 py-1">
      {/* Presets row */}
      <div className="flex flex-wrap gap-2 items-center">
        {presets.map((c) => {
          const hex = c.toUpperCase();
          const selected = current === hex;
          return (
            <button
              key={c}
              type="button"
              onClick={() => handleSelect(c)}
              className={`${swatchSizes} rounded-full ring-offset-2 dark:ring-offset-ui-raised transition-all duration-150 active:scale-90 relative ${
                selected ? 'ring-2 ring-studio-accent shadow-md scale-105' : 'hover:scale-105'
              }`}
              style={{
                backgroundColor: c,
                border: hex === '#FFFFFF' ? '1px solid rgba(0,0,0,0.15)' : 'none',
              }}
              title={c}
            />
          );
        })}

        {/* Custom Spectrum / Sphere Button */}
        <button
          type="button"
          onClick={() => setSpectrumOpen((v) => !v)}
          className={`${swatchSizes} rounded-full flex items-center justify-center transition-all duration-150 active:scale-90 ${
            spectrumOpen ? 'ring-2 ring-studio-accent' : ''
          }`}
          style={COLOUR_SPHERE}
          title="Custom spectrum color"
        >
          <Plus className="w-3.5 h-3.5 text-gray-800 drop-shadow-sm" strokeWidth={2.5} />
        </button>

        {/* Eyedropper Button */}
        {canPickColour() && (
          <button
            type="button"
            onClick={async () => {
              const hex = await pickColour();
              if (hex) handleSelect(hex);
            }}
            className={`${swatchSizes} rounded-full bg-gray-100 dark:bg-ui-high border border-black/5 dark:border-white/10 flex items-center justify-center text-gray-600 dark:text-gray-300 hover:text-studio-accent active:scale-90 transition`}
            title="Sample color from page"
          >
            <Pipette className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Favorites row if present */}
      {favorites.length > 0 && (
        <div className="pt-2 border-t border-black/5 dark:border-white/5">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1.5 flex items-center gap-1">
            <Star className="w-3 h-3 text-amber-500 fill-amber-500" /> Favorites
          </div>
          <div className="flex flex-wrap gap-1.5">
            {favorites.map((fav) => (
              <button
                key={fav}
                type="button"
                onClick={() => handleSelect(fav)}
                className="w-5 h-5 rounded-full transition active:scale-90"
                style={{ backgroundColor: fav }}
                title={fav}
              />
            ))}
          </div>
        </div>
      )}

      {/* Expanded spectrum view */}
      {spectrumOpen && (
        <div className="pt-2 border-t border-black/5 dark:border-white/10 animate-in fade-in duration-150">
          <Spectrum value={current} onChange={handleSelect} />
        </div>
      )}
    </div>
  );
};
