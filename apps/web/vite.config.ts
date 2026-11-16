import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const proxy = {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: false,
      },
    };
export default defineConfig({
  plugins: [react()],
  preview: { strictPort: true, proxy },
  server: {
    port: 5173,
    strictPort: true,
    proxy,
  },
});
