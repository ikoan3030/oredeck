import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function externalGameData(): Plugin {
  const source = resolve(import.meta.dirname, "data");
  const destination = resolve(import.meta.dirname, "public/data");
  const sync = () => {
    mkdirSync(destination, { recursive: true });
    cpSync(source, destination, { recursive: true, force: true });
  };

  return {
    name: "external-game-data",
    buildStart: sync,
    configureServer(server) {
      sync();
      server.watcher.add(source);
      server.watcher.on("change", (path) => {
        if (path.startsWith(source)) {
          sync();
          server.ws.send({ type: "full-reload" });
        }
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), externalGameData()],
  resolve: { alias: { "@": resolve(import.meta.dirname, ".") } },
});
