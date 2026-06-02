import { spawn } from "node:child_process";
import electron from "electron";
import waitOn from "wait-on";

const port = Number(process.env.VITE_DEV_SERVER_PORT ?? 4500);
const clientUrl = `http://localhost:${Number.isInteger(port) ? port : 4500}`;

await waitOn({
  resources: [clientUrl],
  timeout: 30_000,
});

const child = spawn(electron, ["."], {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
