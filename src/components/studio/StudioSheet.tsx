import React from 'react';
import { X } from 'lucide-react';
import { useBack } from '../../services/backStack';

export interface StudioSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon?: React.ReactNode;
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  children: React.ReactNode;
}

export const StudioSheet: React.FC<StudioSheetProps> = ({
  isOpen,
  onClose,
  title,
  icon,
  maxWidth = 'md',
  children,
}) => {
  useBack(isOpen, onClose);

  if (!isOpen) return null;

  const widthClasses = {
    sm: 'sm:max-w-sm',
    md: 'sm:max-w-md',
    lg: 'sm:max-w-lg',
    xl: 'sm:max-w-xl',
    '2xl': 'sm:max-w-2xl',
  }[maxWidth];

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[70] flex items-end sm:items-center justify-center sm:p-4 select-none animate-in fade-in duration-200"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      data-no-pan
    >
      <div
        className={`bg-white dark:bg-ui-panel w-full ${widthClasses} rounded-t-[28px] sm:rounded-[28px] shadow-2xl border border-black/5 dark:border-white/10 max-h-[calc(100dvh-16px)] flex flex-col pb-[var(--sa-bottom)] overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800/80 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {icon && <span className="text-studio-accent flex-shrink-0">{icon}</span>}
            <h3 className="font-serif font-bold text-lg text-gray-900 dark:text-gray-100 truncate">
              {title}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-black/5 dark:hover:bg-white/5 transition"
            title="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5 overflow-y-auto min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
};
