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

// Dev defaults are offset (+2) from the packaged app's canonical ports
// (4500 client / 3100 API) so a `npm run dev` next to a running packaged
// Controller never collides on the first try. Worktree PORT_OFFSET still
// adds on top — main worktree 4502/3102, then 4505/3105, 4508/3108, ...
const DEV_CLIENT_BASE_PORT = 4502;
const DEV_API_BASE_PORT = 3102;

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const clientPort = parsePort(env.VITE_DEV_SERVER_PORT, DEV_CLIENT_BASE_PORT);
  const apiPort = parsePort(env.VITE_API_PORT ?? env.API_PORT ?? env.PORT, DEV_API_BASE_PORT);
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
