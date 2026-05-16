import { useEffect, useState } from 'react';
import type { SegmentPreview } from './SegmentPicker';

/**
 * R-25 (#2): generate one thumbnail per video segment by seeking a single
 * hidden <video> element to each segment's midpoint and painting the frame
 * onto a canvas. Returns `null` for segments that haven't rendered yet (or
 * failed) so callers can render a placeholder.
 *
 * We deliberately use a single shared <video> per hook instance and seek
 * sequentially: spinning up N concurrent <video> tags blows GPU memory on
 * Electron + multiplies network requests. A small (~160px wide) JPEG
 * thumbnail per segment is plenty for the picker chip.
 *
 * Cross-origin (CORS) videos taint the canvas → toDataURL throws. We catch
 * and return `null` for that segment so the caller falls back to a label.
 */
export function useSegmentThumbnails(
  videoUrl: string | null | undefined,
  segments: SegmentPreview[],
  thumbWidth = 160
): Record<number, string | null> {
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({});

  useEffect(() => {
    setThumbs({});
    if (!videoUrl || segments.length === 0) return;
    if (typeof document === 'undefined') return;

    let cancelled = false;
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = videoUrl;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const captureAt = (timeSec: number): Promise<string | null> =>
      new Promise((resolve) => {
        if (!ctx) return resolve(null);
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          if (cancelled) return resolve(null);
          try {
            const w = thumbWidth;
            const ratio = video.videoWidth > 0 ? video.videoHeight / video.videoWidth : 9 / 16;
            const h = Math.max(1, Math.round(w * ratio));
            canvas.width = w;
            canvas.height = h;
            ctx.drawImage(video, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
          } catch {
            resolve(null);
          }
        };
        video.addEventListener('seeked', onSeeked);
        try {
          video.currentTime = Math.max(0, timeSec);
        } catch {
          video.removeEventListener('seeked', onSeeked);
          resolve(null);
        }
      });

    const run = async () => {
      await new Promise<void>((resolve) => {
        if (video.readyState >= 1) return resolve();
        const onMeta = () => {
          video.removeEventListener('loadedmetadata', onMeta);
          resolve();
        };
        const onErr = () => {
          video.removeEventListener('error', onErr);
          resolve();
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('error', onErr);
      });
      if (cancelled) return;
      for (const s of segments) {
        if (cancelled) return;
        const mid = (s.start + s.end) / 2;
        const url = await captureAt(mid);
        if (cancelled) return;
        setThumbs((prev) => ({ ...prev, [s.index]: url }));
      }
    };
    void run();

    return () => {
      cancelled = true;
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    };
  }, [videoUrl, segments, thumbWidth]);

  return thumbs;
}
