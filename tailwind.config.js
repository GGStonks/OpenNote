/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
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
