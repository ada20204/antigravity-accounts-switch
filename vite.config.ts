import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 5173,
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*'
    }
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/runtime/main.ts'),
      name: 'AntigravityEnhancerRuntime',
      fileName: () => 'runtime.js',
      formats: ['iife']
    },
    outDir: 'dist',
    emptyOutDir: false
  }
});
