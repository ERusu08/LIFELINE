/* global process */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The triage server runs on :3001. Proxying /api keeps the app same-origin, so
// phones reaching the app through the HTTPS tunnel can use it too.
const proxy = {
  '/api': { target: process.env.LIFELINE_API || 'http://127.0.0.1:3001', changeOrigin: true },
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true, // fail loudly instead of silently moving to 5174, 5175...
    allowedHosts: ['.loca.lt'],
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: ['.loca.lt'],
    proxy,
  },
})
