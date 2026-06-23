/**
 * R-REC-DESKTOP-AREA — Recorder panel（仅 gif-direct 一条路径）。
 *
 * v2.3 起 mp4-then-gif 分支已下线。整体流程：
 *   1. 进入时拉取 displays + 权限状态；
 *   2. 用户调 fps / 时长 / 最长边 / cursor；
 *   3. 点「选择区域」→ 主进程拉 transparent overlay；
 *   4. 拿到 region 立即调 `recorder:start`；
 *   5. 监听 `recorder:progress`：substep='done' 一定携带 gifPath（终态）；
 *      超 maxBytes 的兜底压缩由主进程 dock 链路自行 maybeRecompressOversizeGif，
 *      panel 端不再串 toolbox chain。
 *
 * 渲染端**不**触碰 ffmpeg / fs。所有 IO 都是 IPC 调用（R-10 / R-11）。
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  RECORDER_FPS_PRESETS,
  RECORDER_DEFAULT_DURATION_SEC,
  RECORDER_MAX_DURATION_SEC,
  RECORDER_DEFAULT_MODE,
  RECORDER_LONG_SIDE_PRESETS,
  RECORDER_DEFAULT_LONG_SIDE,
  type RecorderDisplay,
  type RecorderParams,
  type RecorderPermissionStatus,
  type RecorderProgress,
  type RecorderRegion,
} from '../../shared/types/recorder';
import {
  inputStyle,
  primaryBtn,
  dangerBtn,
  ghostBtn,
  chipStyle,
} from './recorderPanelStyles';

interface RecorderApi {
  listDisplays: () => Promise<unknown>;
  checkPermission: () => Promise<unknown>;
  openSystemPrefs: () => Promise<{ ok: true }>;
  selectRegion: (payload: { displayId?: number }) => Promise<unknown>;
  cancelOverlay: () => Promise<{ ok: true }>;
  start: (payload: { params: RecorderParams }) => Promise<{ sessionId: string; outputPath: string }>;
  stop: (sessionId: string) => Promise<{ ok: boolean }>;
  cancel: (sessionId: string) => Promise<{ ok: boolean }>;
  onProgress: (cb: (p: RecorderProgress) => void) => () => void;
}

interface GiftkBridge {
  recorder?: RecorderApi;
}

function getApi(): RecorderApi | null {
  const g = (window as unknown as { giftk?: GiftkBridge }).giftk;
  return g?.recorder ?? null;
}

const DEFAULT_PARAMS = (): Omit<RecorderParams, 'region'> => ({
  mode: RECORDER_DEFAULT_MODE,
  fps: 15,
  maxDurationSec: RECORDER_DEFAULT_DURATION_SEC,
  captureCursor: true,
  captureAudio: false,
  softMaxBytes: 2 * 1024 * 1024,
  maxBytes: 4 * 1024 * 1024,
  maxWidth: 720,
  maxLongSide: RECORDER_DEFAULT_LONG_SIDE,
});

export const RecorderPanel: React.FC = () => {
  const api = useMemo(getApi, []);
  const [displays, setDisplays] = useState<RecorderDisplay[]>([]);
  const [permission, setPermission] = useState<RecorderPermissionStatus | null>(null);
  const [params, setParams] = useState<Omit<RecorderParams, 'region'>>(DEFAULT_PARAMS);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);
  const [region, setRegion] = useState<RecorderRegion | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RecorderProgress | null>(null);
  const [lastGif, setLastGif] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** fps 自定义输入是否展开（与 preset chip 互斥状态）；放顶部避免触发
   *  react-hooks/rules-of-hooks（不能在 early return 后调 useState）。 */
  const [fpsCustomOpen, setFpsCustomOpen] = useState(false);

  useEffect(() => {
    if (!api) return;
    void (async () => {
      try {
        const d = await api.listDisplays() as RecorderDisplay[];
        setDisplays(d);
        const primary = d.find((x) => x.isPrimary) || d[0];
        if (primary) setSelectedDisplayId(primary.id);
      } catch (e) {
        setError(`枚举显示器失败：${(e as Error).message}`);
      }
      try {
        const p = await api.checkPermission() as RecorderPermissionStatus;
        setPermission(p);
      } catch { /* tolerable on non-mac */ }
    })();
  }, [api]);

  useEffect(() => {
    if (!api) return;
    const off = api.onProgress((p) => {
      setProgress(p);
      if (p.substep === 'done') {
        // gif-direct 是唯一路径：done 时 gifPath 必然是终态 GIF。
        if (p.gifPath) setLastGif(p.gifPath);
        setSessionId(null);
      }
      if (p.substep === 'cancelled' || p.substep === 'error') {
        setSessionId(null);
        if (p.error) setError(p.error);
      }
    });
    return off;
  }, [api]);

  if (!api) {
    return (
      <div style={{ padding: 24, color: '#cfd5df' }}>
        Recorder API 未就绪：preload 未注入 window.giftk.recorder。
      </div>
    );
  }

  async function selectRegion(): Promise<void> {
    if (!api) return;
    setError(null);
    try {
      const result = await api.selectRegion({ displayId: selectedDisplayId ?? undefined }) as { ok: boolean; region?: RecorderRegion; cancelled?: boolean };
      if (result?.ok && result.region) {
        setRegion(result.region);
      } else if (result?.cancelled) {
        // user esc'd; no toast — silent is the right UX
      }
    } catch (e) {
      setError(`选区失败：${(e as Error).message}`);
    }
  }

  async function startRecord(): Promise<void> {
    if (!api || !region) return;
    setError(null);
    setProgress(null);
    setLastGif(null);
    try {
      const full: RecorderParams = { ...params, region };
      const r = await api.start({ params: full });
      setSessionId(r.sessionId);
    } catch (e) {
      setError(`启动失败：${(e as Error).message}`);
    }
  }

  async function stopRecord(): Promise<void> {
    if (!api || !sessionId) return;
    try { await api.stop(sessionId); } catch (e) { setError((e as Error).message); }
  }

  async function cancelRecord(): Promise<void> {
    if (!api || !sessionId) return;
    try { await api.cancel(sessionId); } catch (e) { setError((e as Error).message); }
  }

  const permBlocked = permission && (permission.status === 'denied');

  /** fps preset 是否命中——命中则隐藏自定义框（消除"5 10 15 24 15"重复） */
  const fpsMatchesPreset = RECORDER_FPS_PRESETS.includes(params.fps as (typeof RECORDER_FPS_PRESETS)[number]);
  const showFpsCustomInput = fpsCustomOpen || !fpsMatchesPreset;

  /* ---------- styles (modular) ---------- */
  const card: React.CSSProperties = {
    background: '#161a21',
    border: '1px solid #232833',
    borderRadius: 12,
    padding: 18,
    marginBottom: 14,
  };
  const cardTitle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: '#7d8593',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 14,
  };
  /** Field row: label 上 / control 下；多 field 同行用 fieldGrid 包。 */
  const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 };
  const fieldLabel: React.CSSProperties = {
    fontSize: 11,
    color: '#7d8593',
    fontWeight: 600,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  };
  const recBadge: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 999,
    background: 'rgba(255,79,79,0.12)', border: '1px solid rgba(255,79,79,0.35)',
    color: '#ff8a8a', fontSize: 12, fontWeight: 600,
  };
  const okBadge: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '4px 10px', borderRadius: 999,
    background: 'rgba(95,208,122,0.12)', border: '1px solid rgba(95,208,122,0.35)',
    color: '#5fd07a', fontSize: 12, fontWeight: 600,
  };
  const fullInput: React.CSSProperties = { ...inputStyle, width: '100%' };

  return (
    <div style={{ padding: '20px 24px', color: '#cfd5df' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>区域录屏</h2>
        {sessionId && (
          <span style={recBadge}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff4f4f', boxShadow: '0 0 6px #ff4f4f' }} />
            录制中
          </span>
        )}
        {!sessionId && lastGif && <span style={okBadge}>✓ 已完成</span>}
      </div>
      <p style={{ margin: '4px 0 18px', color: '#7d8593', fontSize: 13 }}>
        在屏幕上框选区域，ffmpeg single-pass 直出 GIF。
      </p>

      {/* permission */}
      {permission ? (
        <div
          style={{
            background: permBlocked ? 'rgba(255,79,79,0.08)' : 'rgba(95,208,122,0.05)',
            border: `1px solid ${permBlocked ? 'rgba(255,79,79,0.35)' : 'rgba(95,208,122,0.25)'}`,
            borderRadius: 10,
            padding: '10px 14px',
            marginBottom: 14,
            display: 'flex',
            gap: 12,
            alignItems: 'center',
          }}
        >
          <div style={{ fontSize: 16 }}>{permBlocked ? '⚠' : '✓'}</div>
          <div style={{ flex: 1, fontSize: 13 }}>{permission.message}</div>
          {permBlocked && permission.systemPrefsUrl ? (
            <button type="button" onClick={() => api?.openSystemPrefs()} style={primaryBtn}>
              打开系统设置
            </button>
          ) : null}
        </div>
      ) : null}

      {/* ──── 主体两栏：左 = 设置卡组；右 = 区域 + CTA ──── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 16,
          alignItems: 'start',
        }}
      >
        {/* LEFT COLUMN：设置卡组 */}
        <div style={{ minWidth: 0 }}>
          {/* SECTION 1: 录制参数 */}
          <div style={card}>
            <div style={cardTitle}>录制参数</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              {/* 显示器（占满两列） */}
              <div style={{ ...field, gridColumn: '1 / -1' }}>
                <div style={fieldLabel}>显示器</div>
                <select value={selectedDisplayId ?? ''} onChange={(e) => setSelectedDisplayId(Number(e.target.value))} style={fullInput}>
                  {displays.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.label} · {d.bounds.width}×{d.bounds.height}{d.isPrimary ? ' · 主屏' : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* fps —— preset 命中时不重复显示 input */}
              <div style={{ ...field, gridColumn: '1 / -1' }}>
                <div style={fieldLabel}>帧率 (fps)</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {RECORDER_FPS_PRESETS.map((p) => (
                    <button key={p} type="button"
                      onClick={() => { setParams({ ...params, fps: p }); setFpsCustomOpen(false); }}
                      style={chipStyle(params.fps === p && !fpsCustomOpen)}>
                      {p}
                    </button>
                  ))}
                  <button type="button"
                    onClick={() => setFpsCustomOpen(!fpsCustomOpen)}
                    style={chipStyle(showFpsCustomInput)}
                    title="自定义帧率"
                  >
                    自定义
                  </button>
                  {showFpsCustomInput && (
                    <input
                      type="number" min={1} max={60} value={params.fps}
                      onChange={(e) => setParams({ ...params, fps: Math.max(1, Math.min(60, Number(e.target.value) || 1)) })}
                      style={{ ...inputStyle, width: 72 }}
                      autoFocus={fpsCustomOpen}
                    />
                  )}
                </div>
              </div>

              {/* 最长边 chip —— v2.3 gif-direct scale 控制 */}
              <div style={{ ...field, gridColumn: '1 / -1' }}>
                <div style={fieldLabel}>最长边 (px)</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {RECORDER_LONG_SIDE_PRESETS.map((L) => (
                    <button key={L} type="button"
                      onClick={() => setParams({ ...params, maxLongSide: L })}
                      style={chipStyle(params.maxLongSide === L)}>
                      {L}
                    </button>
                  ))}
                  <button type="button"
                    onClick={() => setParams({ ...params, maxLongSide: 0 })}
                    style={chipStyle(params.maxLongSide === 0)}
                    title="不缩放，按区域原始分辨率直出"
                  >
                    原始
                  </button>
                </div>
              </div>

              {/* 时长 */}
              <div style={field}>
                <div style={fieldLabel}>最长时长 (s)</div>
                <input
                  type="number" min={1} max={RECORDER_MAX_DURATION_SEC} value={params.maxDurationSec}
                  onChange={(e) => setParams({ ...params, maxDurationSec: Math.max(1, Math.min(RECORDER_MAX_DURATION_SEC, Number(e.target.value) || 1)) })}
                  style={fullInput}
                />
              </div>
              <div style={field}>
                <div style={fieldLabel}>提示阈值 (MB)</div>
                <input
                  type="number" min={0.5} step={0.5}
                  value={(params.softMaxBytes / 1024 / 1024).toFixed(1)}
                  onChange={(e) => setParams({ ...params, softMaxBytes: Math.round(Math.max(0.5, Number(e.target.value) || 2) * 1024 * 1024) })}
                  style={fullInput}
                />
              </div>
              <div style={{ ...field, gridColumn: '1 / -1' }}>
                <div style={fieldLabel}>硬上限 (MB) <span style={{ color: '#7d8593', fontWeight: 400, textTransform: 'none' }}>· 超过自动接 gif-optimize 兜底压缩</span></div>
                <input
                  type="number" min={1} step={0.5}
                  value={(params.maxBytes / 1024 / 1024).toFixed(1)}
                  onChange={(e) => setParams({ ...params, maxBytes: Math.round(Math.max(1, Number(e.target.value) || 4) * 1024 * 1024) })}
                  style={fullInput}
                />
              </div>

              {/* 光标 */}
              <div style={{ ...field, gridColumn: '1 / -1' }}>
                <div style={fieldLabel}>采集选项</div>
                <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: 13, paddingTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={params.captureCursor} onChange={(e) => setParams({ ...params, captureCursor: e.target.checked })} />
                    录入光标
                  </label>
                  <span style={{ color: '#7d8593', fontSize: 12 }}>· GIF 无音轨，音频已禁用</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN：区域 + sticky CTA */}
        <div style={{ position: 'sticky', top: 20, display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          <div style={card}>
            <div style={cardTitle}>录制区域</div>
            <button
              type="button" onClick={selectRegion}
              style={{ ...(region ? ghostBtn : primaryBtn), width: '100%', padding: '10px 14px' }}
            >
              {region ? '🎯 重新选择区域' : '🎯 选择屏幕区域'}
            </button>
            <div style={{ marginTop: 12, padding: '10px 12px', background: '#0e1116', borderRadius: 6, border: '1px dashed #2a2f3a' }}>
              {region ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                  <div><span style={{ color: '#7d8593' }}>尺寸：</span><span style={{ color: '#cfd5df' }}>{region.w} × {region.h} px</span></div>
                  <div><span style={{ color: '#7d8593' }}>原点：</span><span style={{ color: '#cfd5df' }}>({region.x}, {region.y})</span></div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: '#7d8593', textAlign: 'center' }}>未选择区域</div>
              )}
            </div>
          </div>

          {/* sticky CTA card */}
          <div style={{ ...card, marginBottom: 0 }}>
            <div style={cardTitle}>动作</div>
            {!sessionId ? (
              <button type="button" onClick={startRecord} disabled={!region}
                style={{ ...primaryBtn, width: '100%', padding: '12px 22px', fontSize: 15, opacity: region ? 1 : 0.5, cursor: region ? 'pointer' : 'not-allowed' }}>
                ● 开始录制
              </button>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <button type="button" onClick={stopRecord} style={{ ...dangerBtn, width: '100%', padding: '12px 22px', fontSize: 15 }}>
                  ⏹ 停止
                </button>
                <button type="button" onClick={cancelRecord} style={{ ...ghostBtn, width: '100%', padding: '10px 18px' }}>取消</button>
              </div>
            )}
            {progress && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #232833', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 11, color: '#9aa3b2', fontVariantNumeric: 'tabular-nums' }}>
                  录制 · {progress.substep} · {progress.percent}%
                </span>
              </div>
            )}
            {!region && !sessionId && (
              <div style={{ marginTop: 10, fontSize: 11, color: '#7d8593', textAlign: 'center' }}>
                请先选择屏幕区域
              </div>
            )}
          </div>
        </div>
      </div>

      {lastGif && (
        <div style={{ ...card, marginTop: 14, background: 'rgba(95,208,122,0.05)', border: '1px solid rgba(95,208,122,0.25)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>✓ 最近 GIF</span>
          </div>
          <code style={{ display: 'block', fontSize: 12, color: '#cfd5df', wordBreak: 'break-all', padding: '6px 10px', background: '#0e1116', borderRadius: 6 }}>{lastGif}</code>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(255,79,79,0.08)', border: '1px solid rgba(255,79,79,0.35)', borderRadius: 8, fontSize: 13, color: '#ffb3b3', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <span>⚠</span>
          <span style={{ flex: 1, wordBreak: 'break-all' }}>{error}</span>
          <button type="button" onClick={() => setError(null)} style={{ ...ghostBtn, padding: '2px 8px', fontSize: 12 }}>×</button>
        </div>
      )}
    </div>
  );
};
