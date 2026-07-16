import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  server: {
    hmr: false,
    allowedHosts: true,
    watch: {
      ignored: ['**/android/**', '**/downloader/**', '**/dist/**'],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // Groups the whole TF.js + face-detection + mediapipe dependency
          // graph into ONE chunk file, so Rollup resolves circular deps
          // (tfjs-core pulled in from multiple places, tfjs-converter's
          // loadGraphModel binding) entirely within one file instead of a
          // chunk boundary cutting through them — that cut is what produced
          // "T is not a function" originally. Kept as its own chunk (not
          // merged into the main bundle) specifically so it still loads via
          // modelPreloader.ts's dynamic import(), asynchronously, without
          // blocking the main app bundle's parse/render time.
          tfjs: [
            '@tensorflow/tfjs-core',
            '@tensorflow/tfjs-converter',
            '@tensorflow/tfjs-backend-webgl',
            '@tensorflow/tfjs-backend-cpu',
            '@tensorflow-models/face-landmarks-detection',
            '@tensorflow-models/face-detection',
            '@mediapipe/face_mesh',
          ],
        },
      },
    },
  },
});
