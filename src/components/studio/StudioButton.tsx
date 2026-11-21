import React from 'react';
import { haptic } from '../../platform';

export interface StudioButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'glass' | 'danger';
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
  active?: boolean;
  hapticOnPress?: boolean;
  children: React.ReactNode;
}

export const StudioButton: React.FC<StudioButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  active = false,
  hapticOnPress = true,
  className = '',
  onClick,
  disabled,
  children,
  ...rest
}) => {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (hapticOnPress) {
      haptic('light');
    }
    onClick?.(e);
  };

  const base =
    'relative inline-flex items-center justify-center font-medium transition-all duration-150 select-none outline-none focus-visible:ring-2 focus-visible:ring-studio-accent disabled:opacity-40 disabled:pointer-events-none active:scale-[0.96]';

  const sizeClasses = {
    xs: 'h-7 px-2.5 text-xs rounded-lg gap-1.5',
    sm: 'h-8 px-3 text-xs rounded-xl gap-1.5',
    md: 'h-10 px-4 text-sm rounded-xl gap-2',
    lg: 'h-12 px-5 text-base rounded-2xl gap-2.5',
    'icon-sm': 'w-8 h-8 rounded-xl',
    icon: 'w-10 h-10 rounded-xl',
  }[size];

  const variantClasses = {
    primary:
      'bg-studio-accent text-white shadow-md shadow-blue-600/20 hover:bg-studio-accent-hover hover:shadow-lg hover:shadow-blue-600/30',
    secondary: active
      ? 'bg-studio-accent text-white shadow-sm'
      : 'bg-gray-100/90 dark:bg-ui-raised text-gray-800 dark:text-gray-100 hover:bg-gray-200/80 dark:hover:bg-ui-high',
    ghost: active
      ? 'bg-studio-accent-subtle text-studio-accent font-semibold'
      : 'text-gray-700 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/5',
    glass: active
      ? 'bg-studio-accent text-white shadow-md shadow-blue-600/20'
      : 'bg-white/80 dark:bg-ui-raised/80 backdrop-blur-md text-gray-800 dark:text-gray-200 border border-black/5 dark:border-white/10 hover:bg-white dark:hover:bg-ui-raised shadow-sm',
    danger:
      'bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 border border-red-500/20',
  }[variant];

  return (
    <button
      className={`${base} ${sizeClasses} ${variantClasses} ${className}`}
      onClick={handleClick}
      disabled={disabled}
      {...rest}
    >
      {children}
    </button>
  );
};
