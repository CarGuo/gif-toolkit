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

const giftk = (typeof window !== 'undefined' ? window.giftk : undefined);

const SNIFF_TIMEOUT_MS = 60_000;

// Hosts the renderer's "解析直链" button is allowed to surface for. The main
// process re-validates this list — this is purely a UX gate so the button
// never appears for hosts yt-dlp can't handle.
const RESOLVABLE_HOSTS = new Set<string>([
  'youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com',
  'twitter.com', 'x.com', 'mobile.twitter.com', 'video.twimg.com',
  'bilibili.com', 'm.bilibili.com', 'b23.tv', 'player.bilibili.com', 'www.bilibili.com',
  'vimeo.com', 'player.vimeo.com',
  'twitch.tv', 'clips.twitch.tv', 'www.twitch.tv',
  'reddit.com', 'v.redd.it',
  'tiktok.com', 'www.tiktok.com',
  'instagram.com', 'www.instagram.com',
  'dailymotion.com', 'www.dailymotion.com',
  'facebook.com', 'www.facebook.com', 'fb.watch'
]);

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
  const [ytdlpReady, setYtdlpReady] = useState<boolean>(false);
  const [ytdlpVersion, setYtdlpVersion] = useState<string>('');
  const [ytdlpInstalling, setYtdlpInstalling] = useState<boolean>(false);
  const [ytdlpInstallError, setYtdlpInstallError] = useState<string>('');

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
    let off4: (() => void) | null = null;
    if (giftk.onResolveInstallProgress) {
      off4 = giftk.onResolveInstallProgress((p) => {
        if (p.stage === 'starting') {
          setYtdlpInstalling(true);
          setYtdlpInstallError('');
        } else if (p.stage === 'done') {
          setYtdlpInstalling(false);
          setYtdlpReady(true);
          if (p.version) setYtdlpVersion(p.version);
        } else if (p.stage === 'error') {
          setYtdlpInstalling(false);
          setYtdlpInstallError(p.error || 'install failed');
        }
      });
    }
    if (giftk.checkYtdlp) {
      giftk.checkYtdlp().then((s) => {
        setYtdlpReady(!!s.installed);
        if (s.version) setYtdlpVersion(s.version);
      }).catch(() => { /* ignore */ });
    }
    return () => {
      off1();
      off2();
      off3();
      if (off4) {
        off4();
        off4 = null;
      }
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

  const onStart = useCallback(async () => {
    if (!giftk) return;
    if (processable.length === 0) {
      setLogs((prev) => [...prev, `[batch] 没有可处理的任务(只支持 video / gif)`].slice(-300));
      return;
    }
    setProgress({});
    const dir = baseOutputDir || outputDir;
    const tasks: ProcessTask[] = processable.map((m) => ({
      id: m.id,
      media: m,
      options: { ...options, outDir: dir }
    }));
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
    const tasks: ProcessTask[] = [
      { id: media.id, media, options: { ...options, outDir: dir } }
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

  const onInstallYtdlp = useCallback(async () => {
    if (!giftk?.installYtdlp) return;
    // The 'installing' flag is driven by the 'resolve:install-progress' event
    // (single source of truth) — see useEffect above. We only seed it here so
    // the UI reacts instantly even if the 'starting' event has not yet
    // arrived (event-vs-await race), and we deliberately do NOT clear it in
    // the finally block (the 'done'/'error' event will).
    setYtdlpInstalling(true);
    setYtdlpInstallError('');
    try {
      const s = await giftk.installYtdlp();
      setYtdlpReady(!!s.installed);
      if (s.version) setYtdlpVersion(s.version);
      setLogs((prev) => [...prev, `[ytdlp] installed: ${s.binaryPath} (${s.version || 'unknown version'})`].slice(-300));
    } catch (e) {
      const msg = (e as Error).message || '';
      setYtdlpInstallError(msg);
      setYtdlpInstalling(false);
      setLogs((prev) => [...prev, `[ytdlp] install failed: ${msg}`].slice(-300));
    }
  }, []);

  const onResolveEmbedById = useCallback(async (id: string) => {
    if (!giftk?.resolveEmbed) return;
    const m = items.find((i) => i.id === id);
    if (!m) return;
    if (!m.requiresExternalDownload) return;
    if (resolvedMap[id]) return;
    if (resolvingSet.has(id)) return;

    // First-time gate: confirm + install yt-dlp if not present.
    if (!ytdlpReady) {
      const ok = window.confirm(
        `解析直链需要下载 yt-dlp 二进制(开源,MIT License)到本机用户数据目录。\n\n` +
        `· 不会写入安装目录,不会上传任何信息\n` +
        `· 仅在你点击"解析直链"时使用,不会自动启动\n\n` +
        `继续下载?`
      );
      if (!ok) return;
      try {
        await onInstallYtdlp();
      } catch { /* error already logged */ }
      const ready = await giftk.checkYtdlp?.().then((s) => !!s.installed).catch(() => false);
      if (!ready) {
        setLogs((prev) => [...prev, `[resolve] yt-dlp 未就绪,已取消解析`].slice(-300));
        return;
      }
    }

    setResolvingSet((prev) => {
      const n = new Set(prev); n.add(id); return n;
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
      if (msg === 'YT_DLP_NOT_INSTALLED') {
        setLogs((prev) => [...prev, `[resolve] yt-dlp 不在,请先安装`].slice(-300));
        setYtdlpReady(false);
      } else {
        setLogs((prev) => [...prev, `[resolve] 失败: ${msg}`].slice(-300));
      }
    } finally {
      setResolvingSet((prev) => {
        const n = new Set(prev); n.delete(id); return n;
      });
    }
  }, [items, resolvedMap, resolvingSet, ytdlpReady, onInstallYtdlp]);

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
    <div className="app">
      <div className="titlebar">
        <h1>Gif Toolkit · 网页媒体一站式抓取与转换</h1>
        <div className="spacer" />
        <div className="actions">
          <span
            className={`ytdlp-chip ${ytdlpReady ? 'ready' : 'missing'}`}
            title={
              ytdlpReady
                ? `yt-dlp 已就绪${ytdlpVersion ? ' · ' + ytdlpVersion : ''} · 用于解析嵌入视频(YouTube/X/B 站等)`
                : ytdlpInstallError
                  ? `yt-dlp 安装失败: ${ytdlpInstallError}`
                  : '未安装 yt-dlp,需要时再下载(用于解析嵌入视频直链)'
            }
          >
            {ytdlpInstalling ? '⬇ yt-dlp 安装中…' : ytdlpReady ? '✓ yt-dlp' : '⚠ yt-dlp 未装'}
          </span>
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
                onResolveEmbed={onResolveEmbedById}
                isResolving={isResolving}
                resolvableHosts={RESOLVABLE_HOSTS}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="bottom">
        <TaskTable items={items} progress={progress} />
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
    </div>
  );
};

function shortDir(p: string): string {
  if (p.length <= 30) return p;
  return '…' + p.slice(p.length - 28);
}

export default App;
