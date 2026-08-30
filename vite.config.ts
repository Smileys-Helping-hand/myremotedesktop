import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
// vitest/config re-exports Vite's defineConfig with the `test` block typed.
import { defineConfig } from 'vitest/config';

// Tauri drives the dev server, so the port is fixed and failures must be loud
// rather than silently falling back to another port the Rust side won't load.
const DEV_PORT = 1420;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Tauri reads these to decide what the webview can talk to.
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || 'localhost',
    hmr: process.env.TAURI_DEV_HOST
      ? { protocol: 'ws', host: process.env.TAURI_DEV_HOST, port: DEV_PORT + 1 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // WebView2 / WKWebView / WebKitGTK all support modern output.
    target: 'es2022',
    sourcemap: !!process.env.TAURI_DEBUG,
    minify: process.env.TAURI_DEBUG ? false : 'esbuild',
    rollupOptions: {
      output: {
        // Keep the app shell small so the host and client views — the only
        // screens that matter for a session — parse fast. The heavy reference
        // tabs are lazy-loaded on top of this split.
        manualChunks: {
          react: ['react', 'react-dom'],
          icons: ['lucide-react'],
          motion: ['motion/react'],
        },
      },
    },

  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: true,
  },
});
