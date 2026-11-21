import React, { useEffect, useState } from 'react';

type Corner = 'top-right' | 'bottom-right' | 'bottom-left' | 'top-left';

const CORNER_KEY = 'opennote_fps_overlay_corner';

export const FpsOverlay: React.FC = () => {
  const [fps, setFps] = useState<number>(0);
  const [ms, setMs] = useState<number>(0);
  const [corner, setCorner] = useState<Corner>(() => {
    try {
      const saved = localStorage.getItem(CORNER_KEY);
      if (saved === 'top-right' || saved === 'bottom-right' || saved === 'bottom-left' || saved === 'top-left') {
        return saved;
      }
    } catch {
      // ignore
    }
    return 'top-right';
  });

  useEffect(() => {
    let animId: number;
    let frames = 0;
    let lastTime = performance.now();
    let lastUpdate = lastTime;

    const tick = (now: number) => {
      frames++;
      const elapsed = now - lastUpdate;
      if (elapsed >= 250) {
        const calculatedFps = (frames * 1000) / elapsed;
        const frameTimeMs = elapsed / frames;
        setFps(Math.round(calculatedFps * 10) / 10);
        setMs(Math.round(frameTimeMs * 10) / 10);
        frames = 0;
        lastUpdate = now;
      }
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, []);

  const cycleCorner = (e: React.MouseEvent | React.TouchEvent) => {
    e.stopPropagation();
    const next: Record<Corner, Corner> = {
      'top-right': 'bottom-right',
      'bottom-right': 'bottom-left',
      'bottom-left': 'top-left',
      'top-left': 'top-right',
    };
    const newCorner = next[corner];
    setCorner(newCorner);
    try {
      localStorage.setItem(CORNER_KEY, newCorner);
    } catch {
      // ignore
    }
  };

  const cornerClasses: Record<Corner, string> = {
    'top-right': 'top-[calc(var(--sa-top)+3.5rem)] right-[calc(var(--sa-right)+0.75rem)]',
    'bottom-right': 'bottom-[calc(var(--sa-bottom)+3.5rem)] right-[calc(var(--sa-right)+0.75rem)]',
    'bottom-left': 'bottom-[calc(var(--sa-bottom)+3.5rem)] left-[calc(var(--sa-left)+0.75rem)]',
    'top-left': 'top-[calc(var(--sa-top)+3.5rem)] left-[calc(var(--sa-left)+0.75rem)]',
  };

  const target = window.OpenNoteNative?.maxFps ?? (fps > 75 ? 120 : 60);
  const isGood = fps >= target * 0.9;
  const isFair = fps >= target * 0.6;
  const statusDot = isGood ? 'bg-emerald-400' : isFair ? 'bg-amber-400' : 'bg-rose-400';

  return (
    <div
      data-cutout-clear
      data-no-pan
      data-viewport-hole
      onClick={cycleCorner}
      className={`fixed z-50 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/80 text-white backdrop-blur shadow-lg border border-white/20 font-mono text-[11px] font-semibold tabular-nums cursor-pointer select-none active:scale-95 transition-transform ${cornerClasses[corner]}`}
      title="Frame rate (tap to move corner)"
    >
      <span className={`w-2 h-2 rounded-full ${statusDot} animate-pulse`} />
      <span>{fps.toFixed(0)} FPS</span>
      <span className="text-[9px] text-white/60">({ms.toFixed(1)} ms)</span>
    </div>
  );
};
