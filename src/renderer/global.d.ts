import type { GifToolkitApi } from '../preload/index';

declare global {
  interface Window {
    giftk: GifToolkitApi;
  }
}

export {};
