import type { Config } from 'tailwindcss';

export default {
  content: [
    './index.html',
    './src/**/*.{ts,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        m3: {
          surface: '#140e1b',
          'surface-dim': '#100816',
          'surface-bright': '#2d2139',
          'surface-container-lowest': '#0e0813',
          'surface-container-low': '#1c1325',
          'surface-container': '#23192f',
          'surface-container-high': '#2e213d',
          'surface-container-highest': '#3a2a4c',
          primary: '#d0bcff',
          'on-primary': '#381e72',
          'primary-container': '#4f378b',
          'on-primary-container': '#e8def8',
          secondary: '#ccc2dc',
          'on-secondary': '#332d41',
          'secondary-container': '#4a4458',
          'on-secondary-container': '#e8def8',
          tertiary: '#ffb4a9',
          'on-tertiary': '#561e18',
          'tertiary-container': '#73332c',
          'on-tertiary-container': '#ffdad6',
          coral: '#ff8a7a',
          'coral-container': '#5c1d17',
          gold: '#e8b73a',
          'gold-container': '#4a3800',
          mint: '#a8f5cc',
          'mint-container': '#1a5238',
          error: '#ffb4ab',
          'on-error': '#690005',
          outline: '#938f99',
          'outline-variant': '#49454f',
          'outline-subtle': '#352945',
          'on-surface': '#e6e0e9',
          'on-surface-variant': '#cac4d0',
        },
      },
      fontFamily: {
        display: ['"Outfit"', '"Google Sans"', 'system-ui', 'sans-serif'],
        sans: ['"DM Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Cascadia Code"', 'monospace'],
      },
      // Type floor. Text below 11px was unreadable on a 1440p stretched
      // display (docs/audit/ui.md #3); micro is the smallest size allowed.
      // Never go back to arbitrary text-[<11px] values.
      fontSize: {
        micro: ['11px', '15px'],
      },
      borderRadius: {
        '3xl': '24px',
        '4xl': '32px',
      },
      boxShadow: {
        'm3-1': '0px 1px 3px 1px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3)',
        'm3-2': '0px 2px 6px 2px rgba(0, 0, 0, 0.15), 0px 1px 2px 0px rgba(0, 0, 0, 0.3)',
        'm3-3': '0px 4px 8px 3px rgba(0, 0, 0, 0.15), 0px 1px 3px 0px rgba(0, 0, 0, 0.3)',
        'subtle-depth': '0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.25)',
        'surface-inset': 'inset 0 1px 0 rgba(255, 255, 255, 0.05)',
        'keycap': '0 3px 0 #111518, 0 5px 12px rgba(0, 0, 0, 0.45)',
        'keycap-pressed': '0 1px 0 #111518, 0 2px 4px rgba(0, 0, 0, 0.3)',
      },
    },
  },
  plugins: [],
} satisfies Config;
