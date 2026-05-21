/**
 * useSniffPanelController — R-WS-90 P5
 *
 * 由来 (spec-r90 §2.1)
 * --------------------
 * 用户原话:"嗅探部分和输入框应该是脱离 workspace 之外的"。
 * 这个 hook 抽走原本散在 [App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx)
 * 顶层的 4 个 SniffPanel 自治 state:
 *   - urlError                  (URL 输入框校验错误,纯 panel UI 反馈)
 *   - sniffProgress             (SniffPanel 进度条)
 *   - activeSniffMode           (system-chrome 模式下决定是否显示「✓ 完成嗅探」按钮)
 *   - useRealChromeProfile      (真 Chrome 嗅探的 profile 偏好,持久化到 localStorage)
 *
 * 这些 state 与 active workspace **没有任何耦合**:它们由 SniffPanel
 * 自身的 UX 流程驱动,切 tab 时不应跟 active 漂移。把它们从 App.tsx
 * body 里搬到独立 hook 之后,App.tsx 不再持有"嗅探侧"任何 state,
 * 视觉上和代码职责上都符合 spec §2.1 的"SniffPanel 自治"。
 *
 * 兼容性
 * ------
 * setter 命名/签名与原 useState 返回的 setter 完全一致,因此
 * - useSniffSession 接 `setUrlError / setSniffProgress / setActiveSniffMode`
 *   不需要改;
 * - useIpcEvents 接 `setSniffProgress` 不需要改;
 * - SniffSection props 不需要改。
 *
 * 这是纯搬运,语义 0 变化,但 4 个 state 的"物理拥有者"从 App.tsx
 * 顶层挪到了 SniffPanel hook,职责清晰。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { SniffProgress } from '../../shared/types';

export type ActiveSniffMode =
  | 'embed'
  | 'system-chrome'
  | 'ytdlp-direct'
  | 'offline'
  | null;

export interface UseSniffPanelControllerApi {
  urlError: string | null;
  setUrlError: Dispatch<SetStateAction<string | null>>;
  sniffProgress: SniffProgress | null;
  setSniffProgress: Dispatch<SetStateAction<SniffProgress | null>>;
  activeSniffMode: ActiveSniffMode;
  setActiveSniffMode: Dispatch<SetStateAction<ActiveSniffMode>>;
  useRealChromeProfile: boolean;
  setUseRealChromeProfile: Dispatch<SetStateAction<boolean>>;
}

const REAL_CHROME_LS_KEY = 'giftk.useRealChromeProfile';

export function useSniffPanelController(): UseSniffPanelControllerApi {
  const [urlError, setUrlError] = useState<string | null>(null);
  const [sniffProgress, setSniffProgress] = useState<SniffProgress | null>(null);
  const [activeSniffMode, setActiveSniffMode] = useState<ActiveSniffMode>(null);
  const [useRealChromeProfile, setUseRealChromeProfileRaw] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(REAL_CHROME_LS_KEY) === '1';
    } catch {
      return false;
    }
  });

  const setUseRealChromeProfile = useCallback<Dispatch<SetStateAction<boolean>>>(
    (v) => setUseRealChromeProfileRaw(v),
    []
  );

  useEffect(() => {
    try {
      window.localStorage.setItem(REAL_CHROME_LS_KEY, useRealChromeProfile ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [useRealChromeProfile]);

  return {
    urlError,
    setUrlError,
    sniffProgress,
    setSniffProgress,
    activeSniffMode,
    setActiveSniffMode,
    useRealChromeProfile,
    setUseRealChromeProfile
  };
}
