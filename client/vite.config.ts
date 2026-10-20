/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// During development the React app talks to the .NET API through this proxy,
// so the browser only ever sees same-origin "/api/..." requests (no CORS,
// no dev-certificate prompts). The target matches the API's http profile by
// default; override with API_PROXY_TARGET to point at a second API instance
// (e.g. one on :5099) without touching this file.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    // Never inline fonts: the CSP's font-src is 'self' only, so a data: URI font would be refused
    // (the 1.7 KB cyrillic-ext woff2 was inlined by default). Other assets keep Vite's 4 KB default.
    assetsInlineLimit: (file, content) => (file.endsWith('.woff2') ? false : content.length < 4096),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:5029',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    css: false,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
