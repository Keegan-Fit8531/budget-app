import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Relative paths, so the same build works at the site root or under /budget-app/ on GitHub Pages.
  base: './',
})
