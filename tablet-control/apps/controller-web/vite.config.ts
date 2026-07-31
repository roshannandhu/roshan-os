import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { execSync } from "node:child_process";

let gitCommit = "dev";
try {
  gitCommit = execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
} catch {
  gitCommit = "dev";
}

const releaseId = `v1-${gitCommit}-${Date.now()}`;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["pwa-192.svg", "pwa-512.svg"],
      workbox: {
        navigateFallback: null,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkOnly",
            options: {
              cacheName: "api-no-cache",
              expiration: { maxEntries: 0 }
            }
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/media/"),
            handler: "NetworkOnly",
            options: {
              cacheName: "media-no-cache",
              expiration: { maxEntries: 0 }
            }
          },
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith("/clock") || url.pathname.startsWith("/black"),
            handler: "NetworkOnly",
            options: {
              cacheName: "dynamic-no-cache",
              expiration: { maxEntries: 0 }
            }
          }
        ]
      },
      manifest: {
        name: "RoshanOS Controller",
        short_name: "RoshanOS",
        description: "Protected owner controller for a RoshanOS device.",
        theme_color: "#000000",
        background_color: "#000000",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          {
            src: "/pwa-192.svg",
            sizes: "192x192",
            type: "image/svg+xml"
          },
          {
            src: "/pwa-512.svg",
            sizes: "512x512",
            type: "image/svg+xml"
          }
        ]
      },
      devOptions: {
        enabled: true
      },
      injectManifest: {
        data: {
          releaseId
        }
      }
    })
  ],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/media": "http://127.0.0.1:3001",
      "/clock": "http://127.0.0.1:3001",
      "/black": "http://127.0.0.1:3001"
    },
    allowedHosts: true
  }
});
