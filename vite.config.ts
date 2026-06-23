import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // R-REC-DESKTOP-AREA — second renderer entry for the
        // transparent region-selector overlay BrowserWindow.
        main: resolve(__dirname, 'src/renderer/index.html'),
        recorderOverlay: resolve(__dirname, 'src/renderer/recorderOverlay.html'),
        // R-DOCK-FLOATING — third renderer entry for the floating
        // desktop dock BrowserWindow.
        dockOverlay: resolve(__dirname, 'src/renderer/dockOverlay.html')
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
