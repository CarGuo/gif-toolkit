import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest setup for the gif-toolkit monorepo.
 *
 * Architectural notes:
 *  - Renderer code (React components) needs a DOM, so we register a per-file
 *    `// @vitest-environment happy-dom` pragma OR rely on the default node
 *    environment + the renderer test files explicitly opting into happy-dom.
 *    We choose the explicit pragma approach so main-process tests don't pay
 *    the happy-dom startup cost.
 *  - Main-process code touches Electron / fs / child_process. We DO NOT spin
 *    up Electron in tests; instead we test the pure-function modules (helpers,
 *    processor-utils, ffmpeg pure helpers) and mock IPC / electron globally.
 *  - Coverage uses v8 (faster, no Babel) and excludes binaries / dist /
 *    Electron entry points that require an Electron runtime.
 */
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'release'],
    environmentMatchGlobs: [
      ['tests/renderer/**', 'happy-dom']
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: [
        'src/main/helpers.ts',
        'src/main/processor-utils.ts',
        'src/renderer/components/**'
      ],
      exclude: [
        'src/main/index.ts',
        'src/main/binaries.ts',
        'src/preload/**',
        'src/main/sniffer.ts',
        'src/main/downloader.ts',
        'src/main/headlessFetch.ts',
        'src/main/resolver/**',
        'src/main/logger.ts',
        'src/renderer/main.tsx',
        'src/renderer/App.tsx'
      ]
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  }
});
