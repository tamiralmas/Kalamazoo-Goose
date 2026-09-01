import tailwindcss from '@tailwindcss/postcss';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const projectRoot = process.cwd();

export default defineConfig({
  root: resolve(projectRoot, 'github-pages'),
  base: '/Kalamazoo-Goose/',
  publicDir: resolve(projectRoot, 'public'),
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  plugins: [react()],
  build: {
    outDir: resolve(projectRoot, 'dist-pages'),
    emptyOutDir: true,
  },
});
