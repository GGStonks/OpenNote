/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Panels drawn with bg-white take the theme's lightest surface (cream in Sepia).
      backgroundColor: {
        white: 'rgb(var(--ui-white) / <alpha-value>)',
      },
      colors: {
        // Theme-driven (src/theme.ts): the gray scale and the UI surfaces.
        gray: {
          50: 'rgb(var(--g-50) / <alpha-value>)',
          100: 'rgb(var(--g-100) / <alpha-value>)',
          200: 'rgb(var(--g-200) / <alpha-value>)',
          300: 'rgb(var(--g-300) / <alpha-value>)',
          400: 'rgb(var(--g-400) / <alpha-value>)',
          500: 'rgb(var(--g-500) / <alpha-value>)',
          600: 'rgb(var(--g-600) / <alpha-value>)',
          700: 'rgb(var(--g-700) / <alpha-value>)',
          800: 'rgb(var(--g-800) / <alpha-value>)',
          900: 'rgb(var(--g-900) / <alpha-value>)',
          950: 'rgb(var(--g-950) / <alpha-value>)',
        },
        ui: {
          app: 'rgb(var(--ui-app) / <alpha-value>)',
          desk: 'rgb(var(--ui-desk) / <alpha-value>)',
          card: 'rgb(var(--ui-card) / <alpha-value>)',
          side: 'rgb(var(--ui-side) / <alpha-value>)',
          panel: 'rgb(var(--ui-panel) / <alpha-value>)',
          raised: 'rgb(var(--ui-raised) / <alpha-value>)',
          high: 'rgb(var(--ui-high) / <alpha-value>)',
          bar: 'rgb(var(--ui-bar) / <alpha-value>)',
        },
        notability: {
          blue: '#1A73E8',
          dark: '#1C1C1E',
          toolbar: '#F2F2F7',
          paper: '#FFFFFF',
          cream: '#FDFBF7',
          darkpaper: '#18181B',
          grid: '#E2E8F0',
        }
      }
    },
  },
  plugins: [],
}
