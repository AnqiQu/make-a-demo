import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/apps/web/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          amber: "#F59E0B",
          cream: "#FFF7ED",
          umber: "#3A2118",
          clay: "#B9825B",
        },
      },
      fontFamily: {
        body: [
          '"Plus Jakarta Sans"',
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        heading: ['"Lora"', "Georgia", "serif"],
      },
      boxShadow: {
        "soft-panel": "0 28px 90px rgba(58, 33, 24, 0.13)",
        "soft-card": "0 18px 42px rgba(58, 33, 24, 0.12)",
        "soft-control": "0 12px 26px rgba(58, 33, 24, 0.1)",
      },
    },
  },
  plugins: [],
} satisfies Config;
