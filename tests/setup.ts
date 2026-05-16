/**
 * Vitest global setup. Runs once before each test file.
 *
 * - Pulls in @testing-library/jest-dom for `toBeInTheDocument` etc.
 * - Stubs `crypto.randomBytes` only if a test explicitly opts in (we keep the
 *   real one by default so safeName's tie-breaking hash is exercised).
 * - Provides minimal stubs for window APIs that JSDOM/happy-dom miss
 *   (e.g. `URL.createObjectURL`) so component tests don't crash.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Auto-cleanup the DOM between component tests so previous render trees don't
// leak into the next test (RTL ≥9 needs this explicit hook).
afterEach(() => {
  cleanup();
});

// happy-dom doesn't implement URL.createObjectURL / matchMedia. Some preview
// modal code paths reference these; provide a no-op so render() doesn't throw.
if (typeof globalThis.URL !== 'undefined' && !('createObjectURL' in globalThis.URL)) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis.URL as any).createObjectURL = () => 'blob:stub';
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  });
}
