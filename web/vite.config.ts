import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    // Dos paneles: Memolucas (index.html) y el de compras de Coffit (compras.html).
    rollupOptions: { input: { main: fileURLToPath(new URL("index.html", import.meta.url)), compras: fileURLToPath(new URL("compras.html", import.meta.url)) } },
  },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:3100", "/health": "http://127.0.0.1:3100" } },
});
