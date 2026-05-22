/**
 * SniffSection — Step 10 阶段 3 提取的「输入文章 URL + 嗅探入口 + 嗅探进度
 * + 结果通知」整段顶部 home 控件。
 *
 * 由来
 * ----
 * App.tsx 在该段中堆了大约 460 行 JSX：URL 输入、嗅探历史按钮、嗅探主按钮、
 * webview-sniff 拆按钮 (主 + 下拉菜单 + system-chrome 子开关)、离线导入入口、
 * SniffHistoryPicker、嗅探进度条 + 系统 Chrome amber banner、最终 result 的
 * warnings/notice/title。这些视觉同属一个「嗅探区」section.fixed，所以一次性
 * 抽到本文件，并保持 byte-for-byte 等价。
 *
 * 设计原则
 * --------
 * - 仅做视觉外科手术，不动业务逻辑：所有 setState / handler 都通过 props 传入
 * - props 全部 inline 传入，不在此处持有任何 useState / useEffect
 * - 类名、内联 style、文案、aria 字段、行内注释统统保留，避免回归测试漂移
 */
import React from 'react';
import type { SniffProgress, SniffResult } from '../../shared/types';
import { SniffHistoryPicker } from '../components/SniffHistoryPicker';
import type { UseWebviewMenuApi } from '../components/useWebviewMenu';
import type { SniffHistoryEntry } from '../components/useSniffHistory';

const stageLabel = (s: SniffProgress['stage']): string => {
  switch (s) {
    case 'fetching': return '抓取页面';
    case 'parsing': return '解析 DOM';
    case 'probing': return '探测元数据';
    case 'done': return '完成';
  }
};

export interface SniffSectionProps {
  // URL 输入
  url: string;
  setUrl: (v: string) => void;
  urlError: string | null;
  setUrlError: (v: string | null) => void;
  // 嗅探主流
  sniffing: boolean;
  sniffProgress: SniffProgress | null;
  activeSniffMode: 'embed' | 'system-chrome' | 'ytdlp-direct' | 'offline' | null;
  result: SniffResult | null;
  onSniff: () => void;
  onCancel: () => void;
  onPreferredWebviewSniff: () => void;
  onFinalizeSystemChromeSniff: () => void;
  onOfflineImport: () => void;
  // webview-sniff 拆按钮
  webviewMenu: UseWebviewMenuApi;
  useRealChromeProfile: boolean;
  setUseRealChromeProfile: React.Dispatch<React.SetStateAction<boolean>>;
  // 嗅探历史
  sniffHistoryOpen: boolean;
  setSniffHistoryOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sniffHistory: SniffHistoryEntry[];
  removeSniffHistory: (url: string) => void;
  clearSniffHistory: () => void;
  isSniffHistoryLoading: boolean;
}

export function SniffSection(props: SniffSectionProps): JSX.Element {
  const {
    url, setUrl, urlError, setUrlError,
    sniffing, sniffProgress, activeSniffMode, result,
    onSniff, onCancel, onPreferredWebviewSniff, onFinalizeSystemChromeSniff, onOfflineImport,
    webviewMenu, useRealChromeProfile, setUseRealChromeProfile,
    sniffHistoryOpen, setSniffHistoryOpen,
    sniffHistory, removeSniffHistory, clearSniffHistory, isSniffHistoryLoading
  } = props;

  const webviewMenuOpen = webviewMenu.open;
  const setWebviewMenuOpen = webviewMenu.setOpen;
  const preferredWebviewMode = webviewMenu.preferredMode;
  const persistPreferredMode = webviewMenu.setPreferredMode;
  const webviewMenuRef = webviewMenu.menuRef;
  const webviewCaretRef = webviewMenu.caretRef;
  const webviewMenuItemRefs = webviewMenu.itemRefs;
  const webviewMenuAnchor = webviewMenu.anchor;
  const onWebviewMenuItemKeyDown = webviewMenu.onItemKeyDown;

  return (
    <div className="section fixed section-sniff-panel" data-scope="global">
      <h2>输入文章 URL</h2>
      <div className="url-bar">
        <input
          type="text"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (urlError) setUrlError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && onSniff()}
        />
        {/* R-32 — quick picker of recently-sniffed URLs. The
            trigger toggles the popover; the popover itself is
            positioned absolutely inside .url-bar so it floats
            above the rest of the page. */}
        <button
          type="button"
          className={`sniff-hist-trigger${sniffHistoryOpen ? ' open' : ''}`}
          onClick={() => setSniffHistoryOpen((v) => !v)}
          disabled={sniffHistory.length === 0}
          title={sniffHistory.length === 0 ? '暂无解析历史' : '从解析历史选择 URL'}
          aria-haspopup="dialog"
          aria-expanded={sniffHistoryOpen}
          aria-label="解析历史"
        >
          ☰
        </button>
        <button className="primary" onClick={onSniff} disabled={sniffing} style={{ whiteSpace: 'nowrap', minWidth: 96 }}>
          {sniffing ? '嗅探中…' : '嗅探'}
        </button>
        {/* R-44/R-47 — webview-assisted sniff button. Disabled
            while any sniff (headless or webview) is in flight,
            since both paths share `sniffing` and the same UI
            slot for results. R-47 reframes the entry as a
            general-purpose "网页嗅探" since users may use it for
            bot-walled / OAuth pages, not only signed-in ones.
            R-51 — split button: main click runs the user's last
            preferred mode (embedded webview vs system Chrome),
            the caret next to it opens a small menu so they can
            switch. The system-Chrome path bypasses Cloudflare
            TLS / HTTP/2 fingerprint checks by spawning the
            user's actual installed Chrome. */}
        <div className="webview-sniff-split" style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            className="ghost"
            data-testid="webview-sniff-main"
            onClick={onPreferredWebviewSniff}
            disabled={sniffing}
            title={preferredWebviewMode === 'system-chrome'
              ? '在你本机 Chrome / Edge / Brave 中打开,登录或通过验证后关闭窗口完成嗅探(适合 OpenAI / Medium 等高保护站点)'
              : preferredWebviewMode === 'ytdlp-direct'
                ? '把 URL 直接交给 yt-dlp 解析,无需打开任何浏览器(适合 YouTube / X / Bilibili / TikTok 等已知视频站)'
                : '打开内置浏览器,先浏览到目标页面再嗅探(适合需要交互/登录/验证机器人的站点)'}
            style={{ whiteSpace: 'nowrap', borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            {sniffing
              ? '嗅探中…'
              : '浏览器嗅探'}
          </button>
          <button
            ref={webviewCaretRef}
            className="ghost webview-sniff-caret"
            onClick={() => setWebviewMenuOpen((v) => !v)}
            onKeyDown={(ev) => {
              if (ev.key === 'ArrowDown' || ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                setWebviewMenuOpen(true);
              }
            }}
            disabled={sniffing}
            aria-haspopup="menu"
            aria-expanded={webviewMenuOpen}
            aria-label="切换网页嗅探方式"
            title="切换嗅探方式"
            style={{
              whiteSpace: 'nowrap',
              borderTopLeftRadius: 0,
              borderBottomLeftRadius: 0,
              borderLeft: 'none',
              padding: '0 8px',
              minWidth: 'auto'
            }}
          >
            ▾
          </button>
          {webviewMenuOpen ? (
            <div
              ref={webviewMenuRef}
              role="menu"
              aria-label="网页嗅探方式"
              className="webview-sniff-menu"
              style={{
                position: 'absolute', top: 'calc(100% + 4px)',
                ...(webviewMenuAnchor === 'right' ? { right: 0 } : { left: 0 }),
                zIndex: 60,
                width: 320,
                maxWidth: 'calc(100vw - 16px)',
                padding: 6, borderRadius: 8,
                background: 'var(--bg-2, #23252b)', color: 'var(--fg, #e6e7eb)',
                border: '1px solid rgba(255,255,255,0.12)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
              }}
            >
              <button
                ref={(el) => { webviewMenuItemRefs.current[0] = el; }}
                className="ghost"
                role="menuitemradio"
                aria-checked={preferredWebviewMode === 'embed'}
                tabIndex={preferredWebviewMode === 'embed' ? 0 : -1}
                onKeyDown={(ev) => onWebviewMenuItemKeyDown(ev, 0)}
                onClick={() => {
                  persistPreferredMode('embed');
                  setWebviewMenuOpen(false);
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  background: preferredWebviewMode === 'embed' ? 'rgba(42,170,119,0.12)' : 'transparent'
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  嵌入式嗅探(快){preferredWebviewMode === 'embed' ? ' ·' : ''}
                </div>
              </button>
              <button
                ref={(el) => { webviewMenuItemRefs.current[1] = el; }}
                className="ghost"
                role="menuitemradio"
                aria-checked={preferredWebviewMode === 'system-chrome'}
                tabIndex={preferredWebviewMode === 'system-chrome' ? 0 : -1}
                onKeyDown={(ev) => onWebviewMenuItemKeyDown(ev, 1)}
                onClick={() => {
                  persistPreferredMode('system-chrome');
                  setWebviewMenuOpen(false);
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 4,
                  background: preferredWebviewMode === 'system-chrome' ? 'rgba(42,170,119,0.12)' : 'transparent'
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  真 Chrome 嗅探(过 Cloudflare){preferredWebviewMode === 'system-chrome' ? ' ·' : ''}
                </div>
              </button>
              {preferredWebviewMode === 'system-chrome' ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    textAlign: 'left',
                    padding: '8px 10px',
                    marginTop: 4,
                    borderTop: '1px dashed rgba(255,255,255,0.08)',
                    background: 'rgba(42,170,119,0.06)',
                    cursor: 'pointer'
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((e.target as HTMLElement).tagName !== 'INPUT') {
                      setUseRealChromeProfile((v) => !v);
                    }
                  }}
                >
                  <input
                    type="checkbox"
                    checked={useRealChromeProfile}
                    onChange={(e) => setUseRealChromeProfile(e.target.checked)}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      flex: '0 0 auto',
                      width: 'auto',
                      minWidth: 0,
                      margin: 0,
                      marginTop: 2
                    }}
                    aria-label="使用我真实 Chrome profile"
                  />
                  <div style={{ flex: '1 1 auto', minWidth: 0, textAlign: 'left' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text, #ddd)', lineHeight: 1.3 }}>
                      用我的 Chrome 配置
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted, #9aa0aa)', lineHeight: 1.4, marginTop: 2 }}>
                      复用登录态过 CF · 需先退出 Chrome
                    </div>
                  </div>
                </div>
              ) : null}
              <button
                ref={(el) => { webviewMenuItemRefs.current[2] = el; }}
                className="ghost"
                role="menuitemradio"
                aria-checked={preferredWebviewMode === 'ytdlp-direct'}
                tabIndex={preferredWebviewMode === 'ytdlp-direct' ? 0 : -1}
                onKeyDown={(ev) => onWebviewMenuItemKeyDown(ev, 2)}
                onClick={() => {
                  persistPreferredMode('ytdlp-direct');
                  setWebviewMenuOpen(false);
                }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '8px 10px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 4,
                  background: preferredWebviewMode === 'ytdlp-direct' ? 'rgba(42,170,119,0.12)' : 'transparent'
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  yt-dlp 直接抓(YouTube / X / B站 等){preferredWebviewMode === 'ytdlp-direct' ? ' ·' : ''}
                </div>
              </button>
            </div>
          ) : null}
        </div>
        {/* R-55 Fix #3 — Offline import escape hatch. */}
        <button
          className="ghost"
          onClick={onOfflineImport}
          disabled={sniffing}
          title="从本地选择 .mhtml / .html(可带 _files 目录)/ 单图 / 单视频,直接进入处理流程"
          style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
        >
          📂 离线导入
        </button>
        <SniffHistoryPicker
          open={sniffHistoryOpen}
          entries={sniffHistory}
          onPick={(picked) => {
            setUrl(picked);
            if (urlError) setUrlError(null);
            setSniffHistoryOpen(false);
          }}
          onRemove={(picked) => removeSniffHistory(picked)}
          onClear={() => {
            clearSniffHistory();
            setSniffHistoryOpen(false);
          }}
          onClose={() => setSniffHistoryOpen(false)}
          isLoading={isSniffHistoryLoading}
        />
      </div>
      {urlError ? (
        <div className="notice danger">{urlError}</div>
      ) : null}
      {sniffing && sniffProgress ? (
        <div className="sniff-progress">
          <div className="sniff-progress-row">
            <span className="sniff-stage">{stageLabel(sniffProgress.stage)}</span>
            <span className="sniff-counts">
              {typeof sniffProgress.found === 'number' ? `found ${sniffProgress.found}` : ''}
              {typeof sniffProgress.probed === 'number' && typeof sniffProgress.total === 'number'
                ? ` · probed ${sniffProgress.probed}/${sniffProgress.total}`
                : ''}
            </span>
            <span className="sniff-percent">{Math.round(sniffProgress.percent)}%</span>
            {/* R-59 — Always-visible cancel button. */}
            <button
              onClick={onCancel}
              title="取消嗅探"
              style={{
                marginLeft: 8,
                background: 'transparent',
                color: 'var(--danger, #e76f51)',
                border: '1px solid var(--danger, #e76f51)',
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0
              }}
            >
              ✕ 取消
            </button>
          </div>
          <div className="bar-wrap">
            <div className="bar" style={{ width: `${Math.max(0, Math.min(100, sniffProgress.percent))}%` }} />
          </div>
          {sniffProgress.message ? (
            activeSniffMode === 'system-chrome' && sniffProgress.percent >= 55 && sniffProgress.percent < 90 ? (
              <div
                className="notice"
                role="status"
                aria-live="polite"
                style={{
                  marginTop: 6,
                  padding: '8px 10px',
                  background: 'rgba(241, 161, 64, 0.16)',
                  border: '1px solid rgba(241, 161, 64, 0.5)',
                  color: '#f1a140',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  fontWeight: 600
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: '#f1a140',
                    animation: 'sniff-pulse 1s ease-in-out infinite alternate',
                    flexShrink: 0
                  }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>{sniffProgress.message}</span>
                <button
                  onClick={onFinalizeSystemChromeSniff}
                  title="立即结束嗅探并返回到目前已抓到的媒体(无需关闭 Chrome 整个进程)"
                  style={{
                    background: '#2aaa77',
                    color: '#fff',
                    border: 'none',
                    padding: '4px 10px',
                    borderRadius: 4,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: 'pointer',
                    flexShrink: 0
                  }}
                >
                  ✓ 完成嗅探
                </button>
              </div>
            ) : (
              <div className="notice" style={{ marginTop: 4 }}>{sniffProgress.message}</div>
            )
          ) : null}
        </div>
      ) : null}
      {!sniffing && result?.warnings.length ? (
        <div className="notice danger">{result.warnings.join('; ')}</div>
      ) : null}
      {!sniffing && result?.infoNotices?.length ? (
        <div className="notice notice-info">{result.infoNotices.join('; ')}</div>
      ) : null}
      {!sniffing && result?.title ? <div className="notice">{result.title}</div> : null}
    </div>
  );
}
