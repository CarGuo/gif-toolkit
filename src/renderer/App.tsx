import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  SniffResult,
  ProcessOptions,
  TaskProgress,
  ProcessTask,
  PreviewResult,
  SniffProgress,
  SniffedMedia,
  ResolvedMedia
} from '../shared/types';
import { DEFAULT_OPTIONS } from '../shared/types';
import { MediaGrid } from './components/MediaGrid';
import { OptionsForm } from './components/OptionsForm';
import { PreviewModal } from './components/PreviewModal';
import { TaskTable } from './components/TaskTable';
import { LogBox } from './components/LogBox';
import { BatchSegmentModal, type BatchSegmentEntry } from './components/BatchSegmentModal';

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

const SNIFF_TIMEOUT_MS = 60_000;

const App: React.FC = () => {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [sniffing, setSniffing] = useState(false);
  const [sniffProgress, setSniffProgress] = useState<SniffProgress | null>(null);
  const [result, setResult] = useState<SniffResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [options, setOptions] = useState<ProcessOptions>({ ...DEFAULT_OPTIONS });
  const [outputDir, setOutputDir] = useState<string>('');
  const [baseOutputDir, setBaseOutputDir] = useState<string>('');
  const [lastBatchDir, setLastBatchDir] = useState<string>('');
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [processingOne, setProcessingOne] = useState<Set<string>>(new Set());
  const [resolvedMap, setResolvedMap] = useState<Record<string, ResolvedMedia>>({});
  const [resolvingSet, setResolvingSet] = useState<Set<string>>(new Set());
  const [resolveErrorMap, setResolveErrorMap] = useState<Record<string, string>>({});
  const [batchModal, setBatchModal] = useState<BatchSegmentEntry[] | null>(null);

  // Bottom panel (TaskTable + LogBox) resizable height.
  // Persisted in localStorage so the user's preference survives reloads.
  const BOTTOM_H_KEY = 'giftk.bottomPanelHeight';
  const BOTTOM_H_MIN = 80;
  const BOTTOM_H_DEFAULT = 180;
  const [bottomH, setBottomH] = useState<number>(() => {
    if (typeof window === 'undefined') return BOTTOM_H_DEFAULT;
    const raw = window.localStorage.getItem(BOTTOM_H_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= BOTTOM_H_MIN ? n : BOTTOM_H_DEFAULT;
  });

  const sniffReqId = useRef(0);
  const previewReqId = useRef(0);

  useEffect(() => {
    if (!giftk) return;
    giftk.getDefaultOutputDir().then((d) => {
      setOutputDir(d);
      setBaseOutputDir(d);
    }).catch(() => { /* ignore */ });
    const off1 = giftk.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.taskId]: p }));
    });
    const off2 = giftk.onLog((line) => {
      setLogs((prev) => {
        const next = [...prev, line];
        return next.length > 300 ? next.slice(-300) : next;
      });
    });
    const off3 = giftk.onSniffProgress((p) => {
      setSniffProgress(p);
    });
    return () => {
      off1();
      off2();
      off3();
    };
  }, []);

  const items = useMemo(() => {
    const raw = result?.items ?? [];
    if (Object.keys(resolvedMap).length === 0) return raw;
    return raw.map((m) => (resolvedMap[m.id] ? { ...m, resolved: resolvedMap[m.id] } : m));
  }, [result, resolvedMap]);
  const activeMedia = useMemo(
    () => items.find((i) => i.id === activeId) ?? null,
    [items, activeId]
  );

  const onSniff = useCallback(async () => {
    if (!giftk) return;
    const trimmed = url.trim();
    if (!trimmed) {
      setUrlError('请先输入文章 URL');
      return;
    }
    setUrlError(null);
    const myId = ++sniffReqId.current;
    setSniffing(true);
    setSniffProgress({ stage: 'fetching', percent: 0 });
    setResult(null);
    setSelected(new Set());
    setActiveId(null);
    setPreview(null);
    setResolvedMap({});
    setResolvingSet(new Set());
    setResolveErrorMap({});

    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) return;
      if (myId !== sniffReqId.current) return;
      finished = true;
      sniffReqId.current++;
      setSniffing(false);
      setSniffProgress(null);
      setResult({ pageUrl: trimmed, items: [], warnings: [`嗅探超时(>${SNIFF_TIMEOUT_MS / 1000}s),请稍后重试或换一个 URL`] });
    }, SNIFF_TIMEOUT_MS);

    try {
      const r = await giftk.sniff(trimmed);
      if (myId !== sniffReqId.current || finished) return;
      finished = true;
      clearTimeout(timeout);
      setResult(r);
      const auto = new Set(
        r.items
          .filter((i) => (i.kind === 'video' || i.kind === 'gif') && !i.requiresExternalDownload)
          .map((i) => i.id)
      );
      setSelected(auto);
    } catch (e) {
      if (myId !== sniffReqId.current || finished) return;
      finished = true;
      clearTimeout(timeout);
      setResult({ pageUrl: trimmed, items: [], warnings: [(e as Error).message] });
    } finally {
      if (myId === sniffReqId.current) {
        setSniffing(false);
        setSniffProgress(null);
      }
    }
  }, [url]);

  const onPickDir = useCallback(async () => {
    if (!giftk) return;
    const p = await giftk.pickOutputDir();
    if (p) {
      setOutputDir(p);
      setBaseOutputDir(p);
      setLastBatchDir('');
    }
  }, []);

  const onPreview = useCallback(async () => {
    if (!activeMedia || !giftk) return;
    if (activeMedia.kind === 'image') return;
    const myId = ++previewReqId.current;
    setPreviewing(true);
    setPreview(null);
    try {
      const r = await giftk.preview(activeMedia, { ...options, outDir: outputDir });
      if (myId !== previewReqId.current) return;
      setPreview(r);
    } catch (e) {
      if (myId !== previewReqId.current) return;
      const errResult: PreviewResult = {
        taskId: activeMedia.id,
        durationSec: 0,
        width: 0,
        height: 0,
        frames: [],
        error: (e as Error).message
      };
      setPreview(errResult);
    } finally {
      if (myId === previewReqId.current) setPreviewing(false);
    }
  }, [activeMedia, options, outputDir]);

  const processable = useMemo(
     () => items.filter((m) => selected.has(m.id) && (m.kind === 'video' || m.kind === 'gif') && (!m.requiresExternalDownload || !!m.resolved)),
     [items, selected]
  );

  const dispatchBatch = useCallback(async (
    perIdSelection: Record<string, number[]> | null
  ) => {
    if (!giftk) return;
    setProgress({});
    const dir = baseOutputDir || outputDir;
    const tasks: ProcessTask[] = processable.map((m) => {
      const opt: ProcessOptions = { ...options, outDir: dir };
      const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
      const tooLong = m.kind === 'video' && dur > options.maxSegmentSec;
      const userExplicit =
        opt.startSec !== undefined ||
        opt.endSec !== undefined ||
        (opt.selectedSegments && opt.selectedSegments.length > 0);
      // Priority order:
      // 1. Modal-confirmed selection wins (explicit user choice this batch).
      // 2. Per-task options.selectedSegments / startSec / endSec already set
      //    in the OptionsForm or PreviewPanel are honoured untouched.
      // 3. Long video without any explicit pick → R-22 fallback to [0].
      if (perIdSelection && perIdSelection[m.id] && perIdSelection[m.id].length > 0) {
        opt.selectedSegments = perIdSelection[m.id];
      } else if (tooLong && !userExplicit) {
        opt.selectedSegments = [0];
      }
      return { id: m.id, media: m, options: opt };
    });
    const truncated = tasks.filter((t) =>
      t.options.selectedSegments && t.options.selectedSegments.length === 1 && t.options.selectedSegments[0] === 0 &&
      ((t.media.resolved?.durationSec ?? t.media.durationSec ?? 0) > options.maxSegmentSec)
    );
    if (truncated.length > 0) {
      setLogs((prev) => [
        ...prev,
        `[batch] ${truncated.length} 个长视频已默认只处理第 1 段(0..${options.maxSegmentSec}s);如需更多段,请在预览中勾选`
      ].slice(-300));
    }
    try {
      const r = await giftk.startBatch(tasks, result?.title);
      setProcessingOne((prev) => {
        const n = new Set(prev);
        for (const t of tasks) n.add(t.id);
        return n;
      });
      if (r?.outputDir) {
        setLastBatchDir(r.outputDir);
        setLogs((prev) => [...prev, `[batch] outputs -> ${r.outputDir}`].slice(-300));
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg === 'busy' || /\bbusy\b/i.test(msg)) {
        setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[error] startBatch: ${msg}`].slice(-300));
      }
    }
  }, [processable, options, baseOutputDir, outputDir, result]);

  const onStart = useCallback(async () => {
    if (!giftk) return;
    if (processable.length === 0) {
      setLogs((prev) => [...prev, `[batch] 没有可处理的任务(只支持 video / gif)`].slice(-300));
      return;
    }
    // R-23: surface a confirm modal listing every long video with its own
    // segment picker BEFORE dispatching. Skip the modal when:
    //   - no video exceeds maxSegmentSec → nothing to ask
    //   - the user already set selectedSegments / startSec / endSec on the
    //     global options form (treat as "I know what I'm doing")
    const longCandidates: BatchSegmentEntry[] = processable
      .filter((m) => {
        if (m.kind !== 'video') return false;
        const dur = m.resolved?.durationSec ?? m.durationSec ?? 0;
        return dur > options.maxSegmentSec;
      })
      .map((m) => ({ media: m, durationSec: m.resolved?.durationSec ?? m.durationSec ?? 0 }));
    const userExplicitGlobal =
      options.startSec !== undefined ||
      options.endSec !== undefined ||
      (options.selectedSegments && options.selectedSegments.length > 0);
    if (longCandidates.length > 0 && !userExplicitGlobal) {
      setBatchModal(longCandidates);
      return;
    }
    await dispatchBatch(null);
  }, [processable, options, dispatchBatch]);

  const onCancel = useCallback(() => {
    if (!giftk) return;
    if (sniffing) {
      giftk.cancelSniff?.().catch(() => { /* ignore */ });
    }
    giftk.cancelAll().catch(() => { /* ignore */ });
  }, [sniffing]);

  const onProcessOne = useCallback(async (media: SniffedMedia) => {
    if (!giftk) return;
    if (media.kind === 'image') {
      setLogs((prev) => [...prev, `[single] 已跳过(image 不支持处理): ${media.url}`].slice(-300));
      return;
    }
    if (media.requiresExternalDownload && !media.resolved) {
      setLogs((prev) => [...prev, `[single] 已跳过(${media.embedHost || '第三方'} 嵌入,未解析直链): ${media.url}`].slice(-300));
      return;
    }
    const dir = baseOutputDir || outputDir;
    // R-22 (single): mirror onStart's auto-truncation so retry/single-process
    // long videos don't accidentally explode into N segment tasks. The user
    // can still expand to all segments by ticking checkboxes in the modal.
    const optBase: ProcessOptions = { ...options, outDir: dir };
    const dur = media.resolved?.durationSec ?? media.durationSec ?? 0;
    const tooLong = media.kind === 'video' && dur > options.maxSegmentSec;
    const userPickedRange =
      optBase.startSec !== undefined ||
      optBase.endSec !== undefined ||
      (optBase.selectedSegments && optBase.selectedSegments.length > 0);
    if (tooLong && !userPickedRange) {
      optBase.selectedSegments = [0];
      setLogs((prev) => [
        ...prev,
        `[single] 长视频(${dur.toFixed(1)}s)默认只处理第 1 段(0..${options.maxSegmentSec}s);如需更多段,请在预览中勾选`
      ].slice(-300));
    }
    const tasks: ProcessTask[] = [
      { id: media.id, media, options: optBase }
    ];
    setProgress((prev) => {
      const next = { ...prev };
      delete next[media.id];
      return next;
    });
    try {
      const r = await giftk.startBatch(tasks, result?.title);
      setProcessingOne((prev) => {
        const n = new Set(prev);
        n.add(media.id);
        return n;
      });
      if (r?.outputDir) {
        setLastBatchDir(r.outputDir);
        setLogs((prev) => [...prev, `[single] outputs -> ${r.outputDir}`].slice(-300));
      }
    } catch (e) {
      const msg = (e as Error).message || '';
      if (msg === 'busy' || /\bbusy\b/i.test(msg)) {
        setLogs((prev) => [...prev, `[busy] 已有任务在跑,请先取消或等待`].slice(-300));
      } else {
        setLogs((prev) => [...prev, `[error] startBatch(single): ${msg}`].slice(-300));
      }
    }
  }, [options, baseOutputDir, outputDir, result]);

  useEffect(() => {
    if (processingOne.size === 0) return;
    let changed = false;
    const next = new Set(processingOne);
    for (const id of processingOne) {
      const st = progress[id]?.status;
      if (st === 'done' || st === 'failed' || st === 'cancelled' || st === 'skipped') {
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setProcessingOne(next);
  }, [progress, processingOne]);

  const isProcessingOne = useCallback((id: string): boolean => {
    if (processingOne.has(id)) return true;
    const st = progress[id]?.status;
    if (!st) return false;
    return st !== 'done' && st !== 'failed' && st !== 'cancelled' && st !== 'skipped';
  }, [processingOne, progress]);

  const onProcessOneById = useCallback((id: string) => {
    const m = items.find((i) => i.id === id);
    if (!m) return;
    void onProcessOne(m);
  }, [items, onProcessOne]);

  const onResolveEmbedById = useCallback(async (id: string) => {
    if (!giftk?.resolveEmbed) return;
    const m = items.find((i) => i.id === id);
    if (!m) return;
    if (!m.requiresExternalDownload) return;
    if (resolvedMap[id]) return;
    if (resolvingSet.has(id)) return;

    setResolvingSet((prev) => {
      const n = new Set(prev); n.add(id); return n;
    });
    setResolveErrorMap((prev) => {
      if (!prev[id]) return prev;
      const n = { ...prev }; delete n[id]; return n;
    });
    setLogs((prev) => [...prev, `[resolve] ${m.embedHost} ← ${m.pageUrl}`].slice(-300));
    try {
      const r = await giftk.resolveEmbed(m);
      setResolvedMap((prev) => ({ ...prev, [id]: r }));
      // Auto-select the now-resolved item so the user can immediately batch.
      setSelected((prev) => {
        const n = new Set(prev); n.add(id); return n;
      });
      setLogs((prev) => [...prev, `[resolve] ✓ ${r.qualityLabel || ''} ${r.width || '?'}x${r.height || '?'} (${r.extractor || 'ytdlp'})`].slice(-300));
    } catch (e) {
      const msg = (e as Error).message || '';
      const display = msg === 'YT_DLP_UNAVAILABLE'
        ? 'yt-dlp 不可用(可能离线且本地无缓存),稍后再试'
        : msg;
      setResolveErrorMap((prev) => ({ ...prev, [id]: display }));
      setLogs((prev) => [...prev, `[resolve] 失败: ${display}`].slice(-300));
    } finally {
      setResolvingSet((prev) => {
        const n = new Set(prev); n.delete(id); return n;
      });
    }
  }, [items, resolvedMap, resolvingSet]);

  // Auto-batch-resolve: whenever the sniff result changes, kick off resolve
  // for every embed that still needs one. Concurrency is bounded inside the
  // main process resolver (yt-dlp is already CPU-bound), so we just fire all
  // pending IDs and let the resolver coalesce.
  useEffect(() => {
    if (!result || result.items.length === 0) return;
    const pending = result.items.filter(
      (m) => m.requiresExternalDownload && !resolvedMap[m.id] && !resolvingSet.has(m.id) && !resolveErrorMap[m.id]
    );
    for (const m of pending) {
      void onResolveEmbedById(m.id);
    }
    // Intentionally don't depend on resolvedMap/resolvingSet to avoid an
    // immediate re-fire on every state delta — onResolveEmbedById's own
    // guards are enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const isResolving = useCallback((id: string): boolean => resolvingSet.has(id), [resolvingSet]);

  const onOpenOutput = useCallback(() => {
    if (!giftk) return;
    const target = lastBatchDir || outputDir;
    if (!target) return;
    giftk.openOutputDir(target).catch(() => { /* ignore */ });
  }, [outputDir, lastBatchDir]);

  const toggleSelected = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openCard = useCallback((id: string) => {
    setActiveId(id);
    setPreview(null);
  }, []);

  const closeModal = useCallback(() => {
    setActiveId(null);
    setPreview(null);
  }, []);

  // Drag handler for the resizable bottom panel. Computed against
  // window.innerHeight so the gesture maps 1:1 with cursor movement.
  // Persists final value to localStorage on mouseup.
  const onBottomResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = bottomH;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const maxH = Math.max(BOTTOM_H_MIN + 1, Math.floor(window.innerHeight * 0.7));
      const next = Math.min(maxH, Math.max(BOTTOM_H_MIN, startH + dy));
      setBottomH(next);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        // setBottomH is async; read latest from a closure-stable getter.
        // We piggy-back on next tick by reading from state on the next call.
        // Simplest: write the most recent value via a setter snapshot.
        setBottomH((v) => {
          window.localStorage.setItem(BOTTOM_H_KEY, String(v));
          return v;
        });
      } catch { /* ignore quota errors */ }
    };
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [bottomH]);

  if (!giftk) {
    return (
      <div style={{ padding: 24, color: 'var(--text)' }}>
        <h2>Preload 桥接未注入</h2>
        <p style={{ color: 'var(--muted)' }}>
          window.giftk 不可用,请通过 npm run dev 或正式打包后运行此应用,而不是直接打开 index.html。
        </p>
      </div>
    );
  }

  const stageLabel = (s: SniffProgress['stage']): string => {
    switch (s) {
      case 'fetching': return '抓取页面';
      case 'parsing': return '解析 DOM';
      case 'probing': return '探测元数据';
      case 'done': return '完成';
    }
  };

  return (
    <div className="app" style={{ ['--bottom-h' as string]: `${bottomH}px` } as React.CSSProperties}>
      <div className="titlebar">
        <h1>Gif Toolkit · 网页媒体一站式抓取与转换</h1>
        <div className="spacer" />
        <div className="actions">
          <button onClick={onPickDir}>{baseOutputDir ? `根目录: ${shortDir(baseOutputDir)}` : '选择输出目录'}</button>
          <button onClick={onOpenOutput} disabled={!(lastBatchDir || outputDir)}>
            {lastBatchDir ? '打开本次目录' : '打开目录'}
          </button>
        </div>
      </div>

      <div className="body">
        <div className="left">
          <div className="section fixed">
            <h2>1. 输入文章 URL</h2>
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
              <button className="primary" onClick={onSniff} disabled={sniffing}>
                {sniffing ? '嗅探中…' : '嗅探'}
              </button>
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
                </div>
                <div className="bar-wrap">
                  <div className="bar" style={{ width: `${Math.max(0, Math.min(100, sniffProgress.percent))}%` }} />
                </div>
                {sniffProgress.message ? (
                  <div className="notice" style={{ marginTop: 4 }}>{sniffProgress.message}</div>
                ) : null}
              </div>
            ) : null}
            {!sniffing && result?.warnings.length ? (
              <div className="notice danger">{result.warnings.join('; ')}</div>
            ) : null}
            {!sniffing && result?.title ? <div className="notice">{result.title}</div> : null}
          </div>

          <div className="section fixed left-bottom">
            <h2>3. 处理参数</h2>
            <OptionsForm value={options} onChange={setOptions} />
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                className="primary"
                onClick={onStart}
                disabled={processable.length === 0}
                title={processable.length === 0 ? '请先在右侧勾选 video / gif' : '开始批处理'}
              >
                ▶ 开始批处理 ({processable.length}{selected.size !== processable.length ? ` / 共选 ${selected.size}` : ''})
              </button>
              <button onClick={onCancel}>取消</button>
              {lastBatchDir ? (
                <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 'auto' }}>
                  已输出到子目录
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="right">
          <div className="grid-pane">
            <div className="grid-header">
              <h2>已选媒体 {items.length > 0 ? `(${items.length})` : ''}</h2>
              <span className="grid-tip">单击卡片打开大图预览 · 勾选后参与批处理</span>
            </div>
            <div className="grid-scroll">
              <MediaGrid
                items={items}
                selected={selected}
                onToggle={toggleSelected}
                onOpen={openCard}
                onProcessOne={onProcessOneById}
                isProcessing={isProcessingOne}
                onRetryResolve={onResolveEmbedById}
                isResolving={isResolving}
                resolveErrorMap={resolveErrorMap}
              />
            </div>
          </div>
        </div>
      </div>

      <div
        className="bottom-resize-handle"
        onMouseDown={onBottomResizeStart}
        onDoubleClick={() => {
          setBottomH(BOTTOM_H_DEFAULT);
          try { window.localStorage.setItem(BOTTOM_H_KEY, String(BOTTOM_H_DEFAULT)); } catch { /* ignore */ }
        }}
        title="拖动调节高度,双击恢复默认"
        role="separator"
        aria-orientation="horizontal"
      />
      <div className="bottom">
        <TaskTable items={items} progress={progress} onRetry={onProcessOne} />
        <LogBox lines={logs} />
      </div>

      {activeMedia ? (
        <PreviewModal
          media={activeMedia}
          options={options}
          onChangeOptions={setOptions}
          onRequestPreview={onPreview}
          previewing={previewing}
          preview={preview}
          onClose={closeModal}
          onProcessOne={onProcessOne}
          processOneDisabled={isProcessingOne(activeMedia.id) || activeMedia.kind === 'image' || (!!activeMedia.requiresExternalDownload && !activeMedia.resolved)}
        />
      ) : null}

      {batchModal ? (
        <BatchSegmentModal
          entries={batchModal}
          maxSegmentSec={options.maxSegmentSec}
          onCancel={() => setBatchModal(null)}
          onConfirm={(perId) => {
            setBatchModal(null);
            void dispatchBatch(perId);
          }}
        />
      ) : null}
    </div>
  );
};

function shortDir(p: string): string {
  if (p.length <= 30) return p;
  return '…' + p.slice(p.length - 28);
}

export default App;
