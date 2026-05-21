/**
 * R-WS-90 P5f — File-size formatter shared by upload UIs.
 *
 * 历史:`bytesTotal?: number` 字段从 R-73 起就被主进程填充 + DB
 * 持久化(见 [UploadHistoryItem](src/shared/types/upload.ts#L248)
 * + [uploadHistoryRepo](src/main/db/repos/uploadHistoryRepo.ts#L82-L141))。
 * 本次仅补齐 UI 端的展示与 tooltip。
 *
 * 渲染策略:
 *   - bytesTotal 未知 → 返回空串(调用点不显示这列)
 *   - 0 ≤ bytes < 1 KiB → "<n> B"
 *   - 1 KiB ≤ bytes < 1 MiB → "<n.n> KB"
 *   - 1 MiB ≤ bytes < 1 GiB → "<n.n> MB"
 *   - ≥ 1 GiB → "<n.nn> GB"
 * 注:为避免三方依赖,我们用 1024 进制 + 一位小数(GB 用两位),
 * 与 Finder / Explorer 中文系统的常见显示一致。
 */
export function formatBytes(bytes: number | undefined | null): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(2)} GB`;
}
