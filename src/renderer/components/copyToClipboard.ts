/**
 * R-WS-90 P5f — Universal copy-to-clipboard helper.
 *
 * 用户反馈"上传后好像复制所有 markdown 没用",根因在 Electron
 * renderer 的 `navigator.clipboard.writeText` 在以下场景会静默
 * reject(被原代码 `void` 吞掉):
 *   1. modal 内 click 后 user-activation 状态被吞,
 *   2. doc focus 转移到了 webContents 之外,
 *   3. 某些 macOS / Linux 环境的 secure-context 守卫。
 *
 * 修法:渲染端**首选** `window.giftk.clipboardWriteText`(走主进程
 * 原生 clipboard 模块,无 focus / permission 限制);失败再 fallback
 * 到 `navigator.clipboard.writeText`,最后兜底 `document.execCommand`
 * 旧 API。任何一条成功即视为成功。
 *
 * 同时把"刚刚写到剪贴板"的字符数 / 来源记到 console + window 全局
 * 调试钩子(`__giftkLastCopy`),用户截图时即可一眼判断有没有写成功。
 */

interface CopyToClipboardResult {
  ok: boolean;
  via: 'ipc' | 'navigator' | 'execCommand' | 'noop';
  length: number;
  reason?: string;
}

declare global {
  interface Window {
    __giftkLastCopy?: { ts: number; via: string; length: number; preview: string };
  }
}

export async function copyToClipboard(text: string): Promise<CopyToClipboardResult> {
  if (typeof text !== 'string' || text.length === 0) {
    return { ok: false, via: 'noop', length: 0, reason: 'empty-text' };
  }

  // 1) 首选 IPC -> Electron clipboard.writeText
  try {
    const giftk = typeof window !== 'undefined' ? window.giftk : undefined;
    if (giftk && typeof giftk.clipboardWriteText === 'function') {
      const r = await giftk.clipboardWriteText(text);
      if (r && r.ok) {
        recordLastCopy('ipc', text);
        return { ok: true, via: 'ipc', length: text.length };
      }
    }
  } catch (err) {
    // fallthrough — 让后续 fallback 接力,把原因记到 console
    // eslint-disable-next-line no-console
    console.warn('[copyToClipboard] ipc path failed, falling back', err);
  }

  // 2) 退到 navigator.clipboard
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      recordLastCopy('navigator', text);
      return { ok: true, via: 'navigator', length: text.length };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[copyToClipboard] navigator path failed, falling back', err);
  }

  // 3) 兜底 document.execCommand('copy')
  try {
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        recordLastCopy('execCommand', text);
        return { ok: true, via: 'execCommand', length: text.length };
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[copyToClipboard] execCommand path failed', err);
  }

  return { ok: false, via: 'noop', length: text.length, reason: 'all-paths-failed' };
}

function recordLastCopy(via: string, text: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.__giftkLastCopy = {
      ts: Date.now(),
      via,
      length: text.length,
      preview: text.slice(0, 80)
    };
  } catch {
    /* swallow */
  }
}
