import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Node server (server/index.js) owns /api and /uploads and serves the built
// client from ./dist in production. In dev, Vite serves the client on 5174
// with HMR and proxies API/upload requests through to the Node server on 5173.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:5173',
      '/uploads': 'http://localhost:5173',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
