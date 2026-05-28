import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',   // accessible from phone on LAN
    port: 5173,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          engine: ['./src/canvas/CanvasEngine.js', './src/canvas/InputHandler.js', './src/canvas/UndoManager.js'],
          brush:  ['./src/brush/BrushEngine.js'],
          color:  ['./src/color/ColorSystem.js'],
          collab: ['./src/collab/CollabEngine.js'],
        }
      }
    }
  }
});
