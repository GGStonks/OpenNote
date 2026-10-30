import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Pipette, Plus, Star, X } from 'lucide-react';
import { canPickColour, onColourPickerChange, pickColour } from '../services/eyedropper';

/**
 * The "any colour" button: a small colour sphere, every hue around it fading to white at the
 * centre (where its + sits, dark on light), lit from the upper left, with a fine rim.
 */
export const COLOUR_SPHERE: React.CSSProperties = {
  background: [
    'radial-gradient(circle at 34% 28%, rgba(255,255,255,0.7), rgba(255,255,255,0) 32%)',
    'radial-gradient(closest-side, #fff 0%, rgba(255,255,255,0.92) 22%, rgba(255,255,255,0) 78%)',
    `conic-gradient(${Array.from({ length: 13 }, (_, i) => `hsl(${(i * 30) % 360} 88% 56%)`).join(', ')})`,
  ].join(', '),
  boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.10), inset 0 -2px 4px rgba(0,0,0,0.18), 0 1px 3px rgba(0,0,0,0.22)',
};

/**
 * Colour picker of the pen, the Draw tool and the highlighter: preset swatches, the user's
 * favourite colours (shared by all tools, kept on the device), and a full-spectrum picker
 * (saturation / brightness square, hue strip, hex field) for any colour.
 */

const FAV_KEY = 'opennote_favorite_colors';
const MAX_FAVORITES = 24;

// ------------------------------------------------------------------ favourites store
let favorites: string[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) : [];
  } catch {
    return [];
  }
})();
const favListeners = new Set<() => void>();
function setFavorites(next: string[]) {
  favorites = next.slice(0, MAX_FAVORITES);
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(favorites));
  } catch {
    /* storage unavailable */
  }
  favListeners.forEach((fn) => fn());
}
const subscribeFav = (fn: () => void) => {
  favListeners.add(fn);
  return () => favListeners.delete(fn);
};
export function useFavoriteColors(): string[] {
  return useSyncExternalStore(subscribeFav, () => favorites, () => favorites);
}

// ------------------------------------------------------------------ colour maths
export function normalizeHex(v: string): string | null {
  let s = v.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(s) ? `#${s.toUpperCase()}` : null;
}

function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt((normalizeHex(hex) ?? '#000000').slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${to(f(5))}${to(f(3))}${to(f(1))}`.toUpperCase();
}

// ------------------------------------------------------------------ spectrum
function useDrag(onPos: (u: number, v: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      move(e);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (e.buttons || e.pointerType !== 'mouse') if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) move(e);
    },
  };
  function move(e: React.PointerEvent) {
    const r = ref.current!.getBoundingClientRect();
    onPos(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  }
  return { ref, handlers };
}

/** Saturation / brightness square and hue strip; `pointerOnly` leaves out the hex box (it would take the focus). */
export const Spectrum: React.FC<{ value: string; onChange: (hex: string) => void; pointerOnly?: boolean }> = ({ value, onChange, pointerOnly }) => {
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [hex, setHex] = useState(value.toUpperCase());
  // Follow outside changes (a swatch tapped) without losing the hue of greys.
  useEffect(() => {
    if (hsvToHex(...hsv) !== value.toUpperCase()) {
      const n = hexToHsv(value);
      setHsv(n[1] === 0 ? [hsv[0], n[1], n[2]] : n);
    }
    setHex(value.toUpperCase());
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const apply = (h: number, s: number, v: number) => {
    setHsv([h, s, v]);
    onChange(hsvToHex(h, s, v));
  };
  const sv = useDrag((u, w) => apply(hsv[0], u, 1 - w));
  const hue = useDrag((u) => apply(u * 360, hsv[1], hsv[2]));
  // The eyedropper: one tap on the page gives its colour there (services/eyedropper.ts).
  const canPick = useSyncExternalStore(onColourPickerChange, canPickColour, canPickColour);
  const dropper = (cls: string) => (
    <button
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void pickColour().then((c) => {
          const n = c && normalizeHex(c);
          if (!n) return;
          const h = hexToHsv(n);
          setHsv(h[1] === 0 ? [hsv[0], h[1], h[2]] : h);
          onChange(n);
        });
      }}
      className={`h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-semibold flex-shrink-0 bg-black/5 dark:bg-white/10 active:scale-95 transition ${cls}`}
      title="Pick a colour from the page"
    >
      <Pipette className="w-4 h-4" />
      {cls ? 'Pick from page' : ''}
    </button>
  );
  return (
    <div className="mt-2">
      <div
        ref={sv.ref}
        {...sv.handlers}
        className="relative h-32 rounded-xl overflow-hidden cursor-crosshair"
        style={{ touchAction: 'none', background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv[0]} 100% 50%))` }}
      >
        <span
          className="absolute w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow ring-1 ring-black/30 pointer-events-none"
          style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, backgroundColor: value }}
        />
      </div>
      <div
        ref={hue.ref}
        {...hue.handlers}
        className="relative h-4 mt-2 rounded-full cursor-pointer"
        style={{ touchAction: 'none', background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
      >
        <span className="absolute top-1/2 w-4 h-4 -ml-2 -mt-2 rounded-full border-2 border-white shadow ring-1 ring-black/30 pointer-events-none" style={{ left: `${(hsv[0] / 360) * 100}%`, backgroundColor: `hsl(${hsv[0]} 100% 50%)` }} />
      </div>
      {pointerOnly && canPick && (
        <div className="flex items-center gap-2 mt-2">
          <span className="w-8 h-8 rounded-lg border border-white/20 flex-shrink-0" style={{ backgroundColor: value }} />
          {dropper('flex-1 justify-center')}
        </div>
      )}
      {!pointerOnly && (
        <div className="flex items-center gap-2 mt-2">
          <span className="w-8 h-8 rounded-lg border border-black/10 flex-shrink-0" style={{ backgroundColor: value }} />
          {canPick && dropper('')}
          <input
            value={hex}
            onChange={(e) => {
              setHex(e.target.value);
              const n = normalizeHex(e.target.value);
              if (n) onChange(n);
            }}
            onBlur={() => setHex(value.toUpperCase())}
            spellCheck={false}
            className="flex-1 min-w-0 font-mono text-sm px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-ui-panel text-gray-900 dark:text-gray-100 select-text"
            aria-label="Hex colour"
          />
          <button
            onClick={() => {
              const c = value.toUpperCase();
              setFavorites([c, ...favorites.filter((f) => f !== c)]);
            }}
            disabled={favorites.includes(value.toUpperCase())}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-amber-100 text-amber-800 disabled:opacity-40"
            title="Add to favourites"
          >
            <Star className="w-3.5 h-3.5" /> Save
          </button>
        </div>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ picker
export const ColorPicker: React.FC<{ value: string; onChange: (hex: string) => void; presets: string[]; size?: 'lg' | 'sm' }> = ({ value, onChange, presets, size = 'lg' }) => {
  const favs = useFavoriteColors();
  const [custom, setCustom] = useState(false);
  const [editing, setEditing] = useState(false);
  const cur = value.toUpperCase();
  // Presets and the custom-colour button are the same circle: same size, same border, same wrapper
  // (a flex box: an inline button in a block sits on a text line, which pushed it off centre).
  const dot = size === 'lg' ? 'w-8 h-8' : 'w-6 h-6';
  const swatch = (c: string, removable = false) => (
    <div key={c} className="relative flex">
      <button
        onClick={() => (removable && editing ? setFavorites(favs.filter((f) => f !== c)) : onChange(c))}
        className={`${dot} rounded-full border-2 shadow-sm transition ${cur === c.toUpperCase() ? 'border-blue-500 scale-110 ring-2 ring-blue-500/30' : 'border-black/10 dark:border-white/20'}`}
        style={{ backgroundColor: c }}
        title={removable && editing ? `Remove ${c}` : c}
      />
      {removable && editing && (
        <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-600 text-white flex items-center justify-center pointer-events-none">
          <X className="w-3 h-3" />
        </span>
      )}
    </div>
  );
  return (
    <div>
      <div className={`flex flex-wrap items-center ${size === 'lg' ? 'gap-2' : 'gap-1'}`}>
        {presets.map((c) => swatch(c))}
        <div className="relative flex">
          <button
            onClick={() => setCustom((v) => !v)}
            className={`${dot} rounded-full transition flex items-center justify-center ${custom ? 'border-2 border-blue-500 text-blue-600 bg-white dark:bg-ui-high' : ''}`}
            title="Any colour (spectrum, hex)"
            style={custom ? undefined : COLOUR_SPHERE}
          >
            {custom ? (
              <X className={size === 'lg' ? 'w-4 h-4' : 'w-3.5 h-3.5'} />
            ) : (
              <Plus className={`${size === 'lg' ? 'w-3.5 h-3.5' : 'w-3 h-3'} text-gray-700`} strokeWidth={3} />
            )}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between mt-3 mb-1">
        <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1"><Star className="w-3 h-3" /> Favourites</span>
        {favs.length > 0 && (
          <button onClick={() => setEditing((v) => !v)} className="text-[11px] font-semibold text-blue-600">{editing ? 'Done' : 'Edit'}</button>
        )}
      </div>
      {favs.length ? (
        <div className="flex flex-wrap gap-2">{favs.map((c) => swatch(c, true))}</div>
      ) : (
        <p className="text-[11px] text-gray-400">Pick a colour with + and tap Save to keep it here.</p>
      )}
      {custom && <Spectrum value={cur} onChange={onChange} />}
    </div>
  );
};
