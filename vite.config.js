import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, 'ui'),
  build: {
    outDir: path.resolve(__dirname, 'ui/dist'),
    emptyOutDir: true,
  },
  base: '/__nodox/',
})
