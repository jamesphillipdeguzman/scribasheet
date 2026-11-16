/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        studio: {
          bg: "#09090F",
          surface: "#11111B",
          elevated: "#181825",
          border: "#27273A",
          accent: "#A78BFA",
          accentDeep: "#8B5CF6",
          text: "#F5F3FF",
          muted: "#A1A1AA",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "-apple-system", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};
