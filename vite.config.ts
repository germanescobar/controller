import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : fallback;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const clientPort = parsePort(env.VITE_DEV_SERVER_PORT, 4500);
  const apiPort = parsePort(env.VITE_API_PORT ?? env.API_PORT ?? env.PORT, 3100);
  const apiTarget = `http://localhost:${apiPort}`;

  return {
    plugins: [react(), tailwindcss()],
    root: "client",
    envDir: process.cwd(),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "client/src"),
      },
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      port: clientPort,
      proxy: {
        "/api": apiTarget,
        "/ws/terminal": {
          target: apiTarget,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "../dist/client",
    },
  };
});
