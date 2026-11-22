import { defineConfig } from 'vite'

export default defineConfig({
  base: '/app/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
})
