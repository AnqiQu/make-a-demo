import type { Config } from "tailwindcss";

export default {
  content: [
    "./index.html",
    "./demo/app/**/*.{ts,tsx}",
    "./src/app/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      boxShadow: {
        "soft-card": "0 18px 42px rgba(58, 33, 24, 0.12)",
        "soft-control": "0 12px 26px rgba(58, 33, 24, 0.1)",
        "soft-panel": "0 28px 90px rgba(58, 33, 24, 0.13)",
      },
      colors: {
        brand: {
          amber: "#F59E0B",
          clay: "#B9825B",
          cream: "#FFF7ED",
          umber: "#3A2118",
        },
      },
      fontFamily: {
        body: ['"Owlet Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        heading: ['"Owlet Serif"', "Georgia", "serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
