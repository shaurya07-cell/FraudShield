/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        page: '#F4F5F7',
        surface: '#FFFFFF',
        ink: '#1B2433',
        muted: '#5B6575',
        border: '#DCE0E7',
        accent: '#1F4FD8',
        allow: '#1E8E5A',
        review: '#B7791F',
        block: '#C0362C',
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'monospace'],
      },
      borderRadius: {
        DEFAULT: '6px',
        badge: '4px',
      },
    },
  },
  plugins: [],
};
