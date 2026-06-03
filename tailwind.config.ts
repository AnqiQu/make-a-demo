import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./demo/app/**/*.{ts,tsx}"],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
