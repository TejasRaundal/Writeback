import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { writeback } from '@writeback/vite-plugin'

export default defineConfig({
  plugins: [writeback(), react(), tailwindcss()],
})
