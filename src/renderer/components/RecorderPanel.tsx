/**
 * R-REC-DESKTOP-AREA — Recorder panel（双模式 #mp4-then-gif + #gif-direct）。
 *
 * 整体流程：
 *   1. 进入时拉取 displays + 权限状态；
 *   2. 用户调 mode / fps / 时长 / 软硬目标 / cursor / audio；
 *   3. 点「选择区域」→ 主进程拉 transparent overlay；
 *   4. 拿到 region 立即调 `recorder:start`；
 *   5. 监听 `recorder:progress`：
 *      - mode='gif-direct' 时 substep='done' 携带 gifPath → 直接是终态 GIF
 *      - mode='mp4-then-gif' 时 substep='done' 不带 gifPath → 自动调
 *        `startToolboxChain` 派发一个 `video-to-gif` step；监听
 *        `process:progress` 拿 outputs[0] 作为最终 GIF
 *
 * 渲染端**不**触碰 ffmpeg / fs。所有 IO 都是 IPC 调用（R-10 / R-11）。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  RECORDER_FPS_PRESETS,
  RECORDER_DEFAULT_DURATION_SEC,
  RECORDER_MAX_DURATION_SEC,
  RECORDER_DEFAULT_MODE,
  type RecorderDisplay,
  type RecorderMode,
  type RecorderParams,
  type RecorderPermissionStatus,
  type RecorderProgress,
  type RecorderRegion,
} from '../../shared/types/recorder';
import type { TaskProgress, ToolboxChainStep, ToolboxParams } from '../../shared/types';
import {
  inputStyle,
  primaryBtn,
  dangerBtn,
  ghostBtn,
  chipStyle,
  modeCardStyle,
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
  startToolboxChain?: (payload: {
    chainId: string;
    inputPath: string;
    steps: ToolboxChainStep[];
  }) => Promise<unknown>;
  onProgress?: (cb: (p: TaskProgress) => void) => () => void;
}

function getApi(): RecorderApi | null {
  const g = (window as unknown as { giftk?: GiftkBridge }).giftk;
  return g?.recorder ?? null;
}
function getBridge(): GiftkBridge | null {
  return (window as unknown as { giftk?: GiftkBridge }).giftk ?? null;
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
});

function mintChainId(): string {
  return `rec-chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const RecorderPanel: React.FC = () => {
  const api = useMemo(getApi, []);
  const bridge = useMemo(getBridge, []);
  const [displays, setDisplays] = useState<RecorderDisplay[]>([]);
  const [permission, setPermission] = useState<RecorderPermissionStatus | null>(null);
  const [params, setParams] = useState<Omit<RecorderParams, 'region'>>(DEFAULT_PARAMS);
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | null>(null);
  const [region, setRegion] = useState<RecorderRegion | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [progress, setProgress] = useState<RecorderProgress | null>(null);
  const [chainProgress, setChainProgress] = useState<TaskProgress | null>(null);
  const [lastGif, setLastGif] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** fps 自定义输入是否展开（与 preset chip 互斥状态）；放顶部避免触发
   *  react-hooks/rules-of-hooks（不能在 early return 后调 useState）。 */
  const [fpsCustomOpen, setFpsCustomOpen] = useState(false);
  /** R-REC-DESKTOP-AREA #双模式：路线 A 把 mp4 → GIF 串起来时记下 chainId，
   *  按 chainId 过滤 process:progress 取产物。 */
  const chainIdRef = useRef<string | null>(null);

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

  // 路线 A 自动串接：录到 mp4 后立即派发 video-to-gif chain
  async function dispatchVideoToGifChain(mp4Path: string): Promise<void> {
    if (!bridge?.startToolboxChain) {
      setError('toolbox bridge 未就绪，无法自动转 GIF');
      return;
    }
    const chainId = mintChainId();
    chainIdRef.current = chainId;
    const stepParams: ToolboxParams = {
      fps: params.fps,
      width: params.maxWidth,
      softMaxBytes: params.softMaxBytes,
      maxBytes: params.maxBytes,
    };
    const step: ToolboxChainStep = {
      id: `${chainId}-s1`,
      kind: 'video-to-gif',
      params: stepParams,
    };
    setChainProgress({ taskId: step.id, status: 'pending', percent: 0, message: '准备 video-to-gif' });
    try {
      await bridge.startToolboxChain({ chainId, inputPath: mp4Path, steps: [step] });
    } catch (e) {
      chainIdRef.current = null;
      setError(`自动转 GIF 失败：${(e as Error).message}`);
    }
  }

  useEffect(() => {
    if (!api) return;
    const off = api.onProgress((p) => {
      setProgress(p);
      if (p.substep === 'done') {
        // gif-direct 模式：gifPath 已是终态 GIF；mp4-then-gif：gifPath 为
        // undefined，需要派发 video-to-gif chain。
        if (p.gifPath) {
          setLastGif(p.gifPath);
          setSessionId(null);
        } else if (params.mode === 'mp4-then-gif') {
          // 从 recorder 进度里没法直接拿 mp4 路径（startRecorder 返回的
          // outputPath 已经存进 sessionId 同步那一刻；但更稳的是从 done
          // event 直接读 — recorder 主进程的 close handler 已 resolve
          // outputPath。这里 sessionId state 在 start 时就被设过，
          // outputPath 我们走另一份 state。
          // 简化：startRecord() 时把 outputPath 也存到 ref，done 来时读。
          const mp4 = pendingMp4Ref.current;
          if (mp4) {
            void dispatchVideoToGifChain(mp4);
          }
          setSessionId(null);
        } else {
          setSessionId(null);
        }
      }
      if (p.substep === 'cancelled' || p.substep === 'error') {
        setSessionId(null);
        if (p.error) setError(p.error);
      }
    });
    return off;
    // params.mode/maxWidth/etc are read inside via closure; we accept the
    // stale closure for chain dispatch decisions since user can't change
    // mode mid-recording anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, params.mode]);

  // 路线 A：监听 toolbox 链路进度，按 chainId 过滤；step done 时 outputs[0] 即 GIF。
  useEffect(() => {
    if (!bridge?.onProgress) return;
    const off = bridge.onProgress((p) => {
      const chainId = chainIdRef.current;
      if (!chainId) return;
      // taskId 形如 `<chainId>-s1`；按前缀认领
      if (!p.taskId.startsWith(chainId)) return;
      setChainProgress(p);
      if (p.status === 'done' && p.outputs && p.outputs.length > 0) {
        setLastGif(p.outputs[0]);
        chainIdRef.current = null;
      } else if (p.status === 'failed') {
        setError(`转 GIF 失败：${p.error || '未知错误'}`);
        chainIdRef.current = null;
      }
    });
    return off;
  }, [bridge]);

  const pendingMp4Ref = useRef<string | null>(null);

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
    setChainProgress(null);
    setLastGif(null);
    chainIdRef.current = null;
    try {
      const full: RecorderParams = { ...params, region };
      const r = await api.start({ params: full });
      setSessionId(r.sessionId);
      pendingMp4Ref.current = r.outputPath;
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
  const isGifDirect = params.mode === 'gif-direct';
  const setMode = (m: RecorderMode): void => setParams({ ...params, mode: m });

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
        在屏幕上框选区域录制，结束后自动转 GIF。
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
          {/* SECTION 1: 输出模式 */}
          <div style={card}>
            <div style={cardTitle}>输出模式</div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" onClick={() => setMode('mp4-then-gif')}
                title="录到 mp4 后自动转 GIF（质量更准 / 体积更小）"
                style={modeCardStyle(!isGifDirect)}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>🎯 质量优先</div>
                <div style={{ fontSize: 11, color: !isGifDirect ? '#0c1118' : '#7d8593', marginTop: 4 }}>录 mp4 → Phase A-D</div>
              </button>
              <button type="button" onClick={() => setMode('gif-direct')}
                title="ffmpeg single-pass 直出 GIF（录完即拿 / 文件偏大）"
                style={modeCardStyle(isGifDirect)}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>⚡ 极速直出</div>
                <div style={{ fontSize: 11, color: isGifDirect ? '#0c1118' : '#7d8593', marginTop: 4 }}>single-pass GIF</div>
              </button>
            </div>
          </div>

          {/* SECTION 2: 录制参数 */}
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

              {/* 时长 / 最长边 / 软目标 / 硬上限 —— 两列网格充满 */}
              <div style={field}>
                <div style={fieldLabel}>最长时长 (s)</div>
                <input
                  type="number" min={1} max={RECORDER_MAX_DURATION_SEC} value={params.maxDurationSec}
                  onChange={(e) => setParams({ ...params, maxDurationSec: Math.max(1, Math.min(RECORDER_MAX_DURATION_SEC, Number(e.target.value) || 1)) })}
                  style={fullInput}
                />
              </div>
              <div style={{ ...field, opacity: isGifDirect ? 0.45 : 1 }}>
                <div style={fieldLabel}>最长边 (px){isGifDirect && <span style={{ color: '#e0b341', marginLeft: 6 }}>·直出不适用</span>}</div>
                <input
                  type="number" min={200} max={2160} step={20} value={params.maxWidth}
                  disabled={isGifDirect}
                  onChange={(e) => setParams({ ...params, maxWidth: Math.max(200, Math.min(2160, Number(e.target.value) || 720)) })}
                  style={fullInput}
                />
              </div>
              <div style={{ ...field, opacity: isGifDirect ? 0.45 : 1 }}>
                <div style={fieldLabel}>软目标 (MB)</div>
                <input
                  type="number" min={0.5} step={0.5}
                  value={(params.softMaxBytes / 1024 / 1024).toFixed(1)}
                  disabled={isGifDirect}
                  onChange={(e) => setParams({ ...params, softMaxBytes: Math.round(Math.max(0.5, Number(e.target.value) || 2) * 1024 * 1024) })}
                  style={fullInput}
                />
              </div>
              <div style={{ ...field, opacity: isGifDirect ? 0.45 : 1 }}>
                <div style={fieldLabel}>硬上限 (MB)</div>
                <input
                  type="number" min={1} step={0.5}
                  value={(params.maxBytes / 1024 / 1024).toFixed(1)}
                  disabled={isGifDirect}
                  onChange={(e) => setParams({ ...params, maxBytes: Math.round(Math.max(1, Number(e.target.value) || 4) * 1024 * 1024) })}
                  style={fullInput}
                />
              </div>

              {/* 光标 / 音频 占满两列 */}
              <div style={{ ...field, gridColumn: '1 / -1' }}>
                <div style={fieldLabel}>采集选项</div>
                <div style={{ display: 'flex', gap: 18, alignItems: 'center', fontSize: 13, paddingTop: 4 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                    <input type="checkbox" checked={params.captureCursor} onChange={(e) => setParams({ ...params, captureCursor: e.target.checked })} />
                    录入光标
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: isGifDirect ? 'not-allowed' : 'pointer', opacity: isGifDirect ? 0.4 : 1 }}>
                    <input type="checkbox" checked={params.captureAudio} disabled={isGifDirect}
                      onChange={(e) => setParams({ ...params, captureAudio: e.target.checked })} />
                    录入音频<span style={{ color: '#7d8593', fontSize: 12 }}>（GIF 模式自动剥离）</span>
                  </label>
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
            {(progress || chainProgress) && (
              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #232833', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {progress && (
                  <span style={{ fontSize: 11, color: '#9aa3b2', fontVariantNumeric: 'tabular-nums' }}>
                    录制 · {progress.substep} · {progress.percent}%
                  </span>
                )}
                {chainProgress && (
                  <span style={{ fontSize: 11, color: '#9aa3b2', fontVariantNumeric: 'tabular-nums' }}>
                    转 GIF · {chainProgress.status} · {chainProgress.percent}%
                  </span>
                )}
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
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              ✓ 最近 GIF{isGifDirect ? '（极速直出）' : '（质量优先）'}
            </span>
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
