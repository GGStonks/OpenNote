import React, { useEffect, useRef } from 'react';
import { OnScreen } from '../onScreen';
import { useBack } from '../../services/backStack';

export interface StudioPopoverProps {
  isOpen: boolean;
  onClose: () => void;
  align?: 'left' | 'right' | 'center';
  placement?: 'top' | 'bottom';
  className?: string;
  children: React.ReactNode;
}

export const StudioPopover: React.FC<StudioPopoverProps> = ({
  isOpen,
  onClose,
  align = 'center',
  placement = 'bottom',
  className = '',
  children,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  useBack(isOpen, onClose);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('pointerdown', handlePointerDown, true);
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const alignStyles = {
    left: 'left-0',
    right: 'right-0',
    center: 'left-1/2 -translate-x-1/2',
  }[align];

  const placementStyles = placement === 'top' ? 'bottom-full mb-3' : 'top-full mt-3';

  return (
    <div ref={ref} className="contents" onClick={(e) => e.stopPropagation()}>
      <OnScreen
        data-ui-panel
        className={`absolute z-50 studio-glass rounded-3xl p-4 shadow-2xl shadow-black/20 w-80 max-w-[calc(100vw-24px)] max-h-[calc(100dvh-100px)] overflow-y-auto no-scrollbar ${alignStyles} ${placementStyles} ${className}`}
      >
        {children}
      </OnScreen>
    </div>
  );
};
