import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/apps/web/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
