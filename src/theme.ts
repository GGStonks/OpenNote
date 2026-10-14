/**
 * Global UI themes. A theme sets the colours of the interface (library, sidebars, toolbars,
 * modals, settings) through CSS variables read by the Tailwind tokens (tailwind.config.js:
 * the `gray` scale, `ui-*` surfaces, `bg-white`) and turns on the `dark:` classes for dark themes.
 *
 * The note pages are not themed: paper colour and pattern are inline styles from the page's own
 * paper (CanvasPage paperBackground), and `.on-page` resets colour-scheme and text colour (index.css).
 */

export type UiTheme = 'light' | 'dark' | 'sepia' | 'midnight' | 'oled';

interface ThemeDef {
  label: string;
  dark: boolean;
  /** Swatches shown in the theme picker: background, panel, accent text. */
  preview: [string, string, string];
  /** Gray scale 50..950 (hex). */
  gray: string[];
  /** Surfaces (hex). */
  ui: Record<'app' | 'desk' | 'card' | 'side' | 'panel' | 'raised' | 'high' | 'bar' | 'white', string>;
}

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

const GRAY = ['#F9FAFB', '#F3F4F6', '#E5E7EB', '#D1D5DB', '#9CA3AF', '#6B7280', '#4B5563', '#374151', '#1F2937', '#111827', '#030712'];
const STONE = ['#FAF7F2', '#F2ECE1', '#E4DACB', '#D2C4AE', '#A8977D', '#7F6F58', '#635643', '#4A3F31', '#2F281F', '#211B14', '#120E0A'];
const SLATE = ['#F8FAFC', '#F1F5F9', '#E2E8F0', '#CBD5E1', '#94A3B8', '#64748B', '#475569', '#334155', '#1E293B', '#0F172A', '#020617'];
const NEUTRAL = ['#FAFAFA', '#F5F5F5', '#E5E5E5', '#D4D4D4', '#A3A3A3', '#737373', '#525252', '#404040', '#262626', '#171717', '#0A0A0A'];

export const THEMES: Record<UiTheme, ThemeDef> = {
  light: {
    label: 'Light',
    dark: false,
    preview: ['#F2F2F7', '#FFFFFF', '#111827'],
    gray: GRAY,
    ui: { app: '#F2F2F7', desk: '#E5E5EA', card: '#F9F9FB', side: '#ECECF1', panel: '#FFFFFF', raised: '#F3F4F6', high: '#E5E7EB', bar: '#1C1C1E', white: '#FFFFFF' },
  },
  dark: {
    label: 'Dark',
    dark: true,
    preview: ['#121214', '#1C1C1E', '#F3F4F6'],
    gray: GRAY,
    ui: { app: '#121214', desk: '#0E0E10', card: '#2C2C2E', side: '#1C1C1E', panel: '#1C1C1E', raised: '#2C2C2E', high: '#3A3A3C', bar: '#1C1C1E', white: '#FFFFFF' },
  },
  sepia: {
    label: 'Sepia',
    dark: false,
    preview: ['#EFE7D6', '#FBF6EA', '#3B3024'],
    gray: STONE,
    ui: { app: '#EFE7D6', desk: '#E4D9C2', card: '#F7F0E1', side: '#E9DFCA', panel: '#FBF6EA', raised: '#F2EAD8', high: '#E6DAC2', bar: '#3B3024', white: '#FBF6EA' },
  },
  midnight: {
    label: 'Midnight Slate',
    dark: true,
    preview: ['#0F172A', '#16213A', '#E2E8F0'],
    gray: SLATE,
    ui: { app: '#0F172A', desk: '#0A1120', card: '#1E293B', side: '#111B31', panel: '#16213A', raised: '#1E293B', high: '#334155', bar: '#1E293B', white: '#FFFFFF' },
  },
  oled: {
    label: 'OLED Black',
    dark: true,
    preview: ['#000000', '#0A0A0A', '#F5F5F5'],
    gray: NEUTRAL,
    ui: { app: '#000000', desk: '#000000', card: '#121212', side: '#000000', panel: '#0A0A0A', raised: '#161616', high: '#262626', bar: '#121212', white: '#FFFFFF' },
  },
};

export const THEME_IDS = Object.keys(THEMES) as UiTheme[];

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** Applies a theme to the whole document (CSS variables, `dark` class, browser chrome colour). */
export function applyTheme(id: UiTheme): void {
  const t = THEMES[id] ?? THEMES.light;
  const root = document.documentElement;
  t.gray.forEach((hex, i) => root.style.setProperty(`--g-${STEPS[i]}`, rgb(hex)));
  for (const [k, hex] of Object.entries(t.ui)) root.style.setProperty(`--ui-${k}`, rgb(hex));
  root.classList.toggle('dark', t.dark);
  root.style.colorScheme = t.dark ? 'dark' : 'light';
  document.body.style.backgroundColor = t.ui.app;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.ui.app);
}
