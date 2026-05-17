/**
 * R-45 — Upload settings modal.
 *
 * One modal, 5 tabs (one per backend). Active backend is set via the
 * top dropdown — that's the backend used by "⚡ 上传所有产物" by default.
 *
 * Secrets handling: we receive masked secret values from main
 * (`••••••`). When the user touches a field we leave whatever they
 * typed; when they don't, we re-submit the mask back to main, which
 * preserves the prior persisted value (mergeMaskedSettings in
 * uploader/index.ts).
 */
import React, { useEffect, useState } from 'react';
import type {
  AliyunOssConfig,
  CustomWebConfig,
  GithubConfig,
  QiniuConfig,
  TencentCosConfig,
  UploadBackend,
  UploadConfigs
} from '../../shared/types';
import { backendLabel } from './useUploadHistory';

const BACKENDS: UploadBackend[] = ['customWeb', 'github', 'qiniu', 'aliyunOss', 'tencentCos'];

interface Props {
  initial: UploadConfigs;
  onClose: () => void;
  onSave: (c: UploadConfigs) => Promise<void>;
}

export const UploadSettingsModal: React.FC<Props> = ({ initial, onClose, onSave }) => {
  const [active, setActive] = useState<UploadBackend>(initial.active || 'customWeb');
  const [tab, setTab] = useState<UploadBackend>(initial.active || 'customWeb');
  const [customWeb, setCustomWeb] = useState<CustomWebConfig>(initial.customWeb || { url: '', urlPath: '$.data.url' });
  const [github, setGithub] = useState<GithubConfig>(initial.github || { token: '', repo: '', branch: 'main', pathPrefix: 'images' });
  const [qiniu, setQiniu] = useState<QiniuConfig>(initial.qiniu || { accessKey: '', secretKey: '', bucket: '', domain: '', region: 'z0' });
  const [aliyun, setAliyun] = useState<AliyunOssConfig>(initial.aliyunOss || { accessKeyId: '', accessKeySecret: '', bucket: '', region: '' });
  const [cos, setCos] = useState<TencentCosConfig>(initial.tencentCos || { secretId: '', secretKey: '', bucket: '', region: '' });
  const [maxConcurrent, setMaxConcurrent] = useState<number>(initial.maxConcurrent ?? 3);
  const [maxRetries, setMaxRetries] = useState<number>(initial.maxRetries ?? 2);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  // R-46 — "测试连接" probe state, per backend tab.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; url?: string; error?: string; durationMs?: number } | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const buildDraftConfigs = (): UploadConfigs => ({
    active,
    customWeb,
    github,
    qiniu,
    aliyunOss: aliyun,
    tencentCos: cos,
    maxConcurrent,
    maxRetries
  });

  const onSubmit = async (): Promise<void> => {
    setError(null);
    setSaving(true);
    try {
      await onSave(buildDraftConfigs());
      onClose();
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setSaving(false);
    }
  };

  // R-46 — Test the currently visible tab (i.e. `tab`, NOT `active`).
  // We pass the unsaved draft to main; main merges masked secrets
  // with the persisted config so the user need not save first.
  const onTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const giftk = (window as unknown as { giftk?: { uploadTest?: (p: { backend: UploadBackend; configs: UploadConfigs }) => Promise<{ ok: boolean; url?: string; error?: string; durationMs?: number }> } }).giftk;
      if (!giftk?.uploadTest) {
        setTestResult({ ok: false, error: 'uploadTest IPC not available' });
        return;
      }
      const r = await giftk.uploadTest({ backend: tab, configs: buildDraftConfigs() });
      setTestResult(r);
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message || String(e) });
    } finally {
      setTesting(false);
    }
  };

  // R-46 — Qiniu region auto-detect.
  const onProbeQiniuRegion = async (): Promise<void> => {
    setProbing(true);
    setProbeError(null);
    try {
      const giftk = (window as unknown as { giftk?: { uploadQiniuProbeRegion?: (p: { accessKey: string; bucket: string }) => Promise<{ ok: boolean; region?: string; host?: string; error?: string }> } }).giftk;
      if (!giftk?.uploadQiniuProbeRegion) {
        setProbeError('uploadQiniuProbeRegion IPC not available');
        return;
      }
      if (!qiniu.accessKey || !qiniu.bucket) {
        setProbeError('请先填 AccessKey 与 Bucket 再探测 region');
        return;
      }
      const r = await giftk.uploadQiniuProbeRegion({ accessKey: qiniu.accessKey, bucket: qiniu.bucket });
      if (r.ok && r.region) {
        setQiniu({ ...qiniu, region: r.region as QiniuConfig['region'] });
      } else {
        setProbeError(r.error || '七牛 region 探测失败');
      }
    } finally {
      setProbing(false);
    }
  };

  // R-46 — JS-side clamp; HTML min/max only constrains spinner clicks.
  const clampInt = (v: string, lo: number, hi: number, fb: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  };

  const formStyle: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: '120px 1fr', columnGap: 10, rowGap: 8, alignItems: 'center'
  };
  const inputCss: React.CSSProperties = { padding: '4px 8px', fontSize: 12 };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ background: 'var(--panel, #1e1f24)', color: 'var(--text, #ddd)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: 16, width: 720, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600 }}>📤 图床上传设置</div>
          <button onClick={onClose} disabled={saving}>关闭</button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>当前默认后端:</span>
          <select value={active} onChange={(e) => setActive(e.target.value as UploadBackend)} style={inputCss}>
            {BACKENDS.map((b) => <option key={b} value={b}>{backendLabel(b)}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          {BACKENDS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => { setTab(b); setTestResult(null); }}
              className={tab === b ? 'tab-btn active' : 'tab-btn'}
              style={{ fontSize: 11, padding: '4px 10px', background: tab === b ? 'rgba(255,255,255,0.06)' : 'transparent', border: 'none', cursor: 'pointer', color: tab === b ? 'var(--text)' : 'var(--muted)' }}
            >
              {backendLabel(b)}{active === b ? ' ✓' : ''}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
          {tab === 'customWeb' && (
            <div style={formStyle}>
              <Label>POST URL</Label>
              <input style={inputCss} placeholder="https://example.com/upload" value={customWeb.url || ''} onChange={(e) => setCustomWeb({ ...customWeb, url: e.target.value })} />
              <Label>file 字段名</Label>
              <input style={inputCss} placeholder="file" value={customWeb.fileField || ''} onChange={(e) => setCustomWeb({ ...customWeb, fileField: e.target.value })} />
              <Label>URL JSONPath</Label>
              <input style={inputCss} placeholder="$.data.url" value={customWeb.urlPath || ''} onChange={(e) => setCustomWeb({ ...customWeb, urlPath: e.target.value })} />
              <Label>Authorization</Label>
              <input style={inputCss} placeholder="Bearer xxx" value={(customWeb.headers && customWeb.headers['Authorization']) || ''} onChange={(e) => setCustomWeb({ ...customWeb, headers: { ...customWeb.headers, Authorization: e.target.value } })} />
              <Help>请求体为 multipart/form-data,fileField 默认为 file。响应需返回 JSON,通过 JSONPath(支持 $.data.url / data.list[0].url 等)取出公网 URL。</Help>
            </div>
          )}
          {tab === 'github' && (
            <div style={formStyle}>
              <Label>Token (PAT)</Label>
              <input style={inputCss} type="password" placeholder="ghp_xxx" value={github.token || ''} onChange={(e) => setGithub({ ...github, token: e.target.value })} />
              <Label>Repo</Label>
              <input style={inputCss} placeholder="user/repo" value={github.repo || ''} onChange={(e) => setGithub({ ...github, repo: e.target.value })} />
              <Label>Branch</Label>
              <input style={inputCss} placeholder="main" value={github.branch || ''} onChange={(e) => setGithub({ ...github, branch: e.target.value })} />
              <Label>路径前缀</Label>
              <input style={inputCss} placeholder="images" value={github.pathPrefix || ''} onChange={(e) => setGithub({ ...github, pathPrefix: e.target.value })} />
              <Label>自定义 CDN 域名</Label>
              <input style={inputCss} placeholder="https://cdn.jsdelivr.net/gh/{repo}@{branch}" value={github.customDomain || ''} onChange={(e) => setGithub({ ...github, customDomain: e.target.value })} />
              <Help>Token 需要 repo scope。文件路径自动追加日期段(yyyymmdd)以避免重名。</Help>
            </div>
          )}
          {tab === 'qiniu' && (
            <div style={formStyle}>
              <Label>AccessKey</Label>
              <input style={inputCss} value={qiniu.accessKey || ''} onChange={(e) => setQiniu({ ...qiniu, accessKey: e.target.value })} />
              <Label>SecretKey</Label>
              <input style={inputCss} type="password" value={qiniu.secretKey || ''} onChange={(e) => setQiniu({ ...qiniu, secretKey: e.target.value })} />
              <Label>Bucket</Label>
              <input style={inputCss} value={qiniu.bucket || ''} onChange={(e) => setQiniu({ ...qiniu, bucket: e.target.value })} />
              <Label>绑定域名</Label>
              <input style={inputCss} placeholder="cdn.example.com" value={qiniu.domain || ''} onChange={(e) => setQiniu({ ...qiniu, domain: e.target.value })} />
              <Label>Region</Label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <select style={inputCss} value={qiniu.region || 'z0'} onChange={(e) => setQiniu({ ...qiniu, region: e.target.value as QiniuConfig['region'] })}>
                  <option value="z0">z0 华东</option>
                  <option value="z1">z1 华北</option>
                  <option value="z2">z2 华南</option>
                  <option value="cn-east-2">cn-east-2 华东-浙江2</option>
                  <option value="na0">na0 北美</option>
                  <option value="as0">as0 东南亚</option>
                </select>
                <button type="button" onClick={() => void onProbeQiniuRegion()} disabled={probing} style={{ fontSize: 11, padding: '4px 8px' }} title="向 uc.qbox.me 查询该 bucket 的接入 region(无需 secret)">
                  {probing ? '探测中…' : '🔎 自动探测'}
                </button>
              </div>
              <Label>Key 前缀</Label>
              <input style={inputCss} placeholder="(可选) blog" value={qiniu.keyPrefix || ''} onChange={(e) => setQiniu({ ...qiniu, keyPrefix: e.target.value })} />
              <Help>SDK-less 实现:主进程用 HMAC-SHA1 签 UpToken 后 multipart 上传到对应 region 的 upload host。</Help>
            </div>
          )}
          {tab === 'aliyunOss' && (
            <div style={formStyle}>
              <Label>AccessKeyId</Label>
              <input style={inputCss} value={aliyun.accessKeyId || ''} onChange={(e) => setAliyun({ ...aliyun, accessKeyId: e.target.value })} />
              <Label>AccessKeySecret</Label>
              <input style={inputCss} type="password" value={aliyun.accessKeySecret || ''} onChange={(e) => setAliyun({ ...aliyun, accessKeySecret: e.target.value })} />
              <Label>Bucket</Label>
              <input style={inputCss} value={aliyun.bucket || ''} onChange={(e) => setAliyun({ ...aliyun, bucket: e.target.value })} />
              <Label>Region</Label>
              <input style={inputCss} placeholder="oss-cn-hangzhou" value={aliyun.region || ''} onChange={(e) => setAliyun({ ...aliyun, region: e.target.value })} />
              <Label>自定义 CNAME</Label>
              <input style={inputCss} placeholder="(可选) cdn.example.com" value={aliyun.customDomain || ''} onChange={(e) => setAliyun({ ...aliyun, customDomain: e.target.value })} />
              <Label>Key 前缀</Label>
              <input style={inputCss} placeholder="(可选) blog" value={aliyun.keyPrefix || ''} onChange={(e) => setAliyun({ ...aliyun, keyPrefix: e.target.value })} />
              <Help>使用 Authorization v1 签名(HMAC-SHA1),不依赖 ali-oss SDK。</Help>
            </div>
          )}
          {tab === 'tencentCos' && (
            <div style={formStyle}>
              <Label>SecretId</Label>
              <input style={inputCss} value={cos.secretId || ''} onChange={(e) => setCos({ ...cos, secretId: e.target.value })} />
              <Label>SecretKey</Label>
              <input style={inputCss} type="password" value={cos.secretKey || ''} onChange={(e) => setCos({ ...cos, secretKey: e.target.value })} />
              <Label>Bucket</Label>
              <input style={inputCss} placeholder="mybucket-1255000000" value={cos.bucket || ''} onChange={(e) => setCos({ ...cos, bucket: e.target.value })} />
              <Label>Region</Label>
              <input style={inputCss} placeholder="ap-shanghai" value={cos.region || ''} onChange={(e) => setCos({ ...cos, region: e.target.value })} />
              <Label>自定义域名</Label>
              <input style={inputCss} placeholder="(可选) cdn.example.com" value={cos.customDomain || ''} onChange={(e) => setCos({ ...cos, customDomain: e.target.value })} />
              <Label>Key 前缀</Label>
              <input style={inputCss} placeholder="(可选) blog" value={cos.keyPrefix || ''} onChange={(e) => setCos({ ...cos, keyPrefix: e.target.value })} />
              <Help>使用 q-sign-algorithm=sha1 签名(无 SDK)。bucket 必须含 -appid 后缀。</Help>
            </div>
          )}
        </div>

        {error ? <div style={{ color: '#ef5b6e', fontSize: 12 }}>✖ {error}</div> : null}
        {probeError ? <div style={{ color: '#ef5b6e', fontSize: 12 }}>✖ region 探测:{probeError}</div> : null}
        {testResult ? (
          <div style={{ fontSize: 12, padding: 6, borderRadius: 4, background: testResult.ok ? 'rgba(74,222,128,0.08)' : 'rgba(239,91,110,0.08)', border: `1px solid ${testResult.ok ? 'rgba(74,222,128,0.3)' : 'rgba(239,91,110,0.3)'}` }}>
            {testResult.ok
              ? <span style={{ color: '#4ade80' }}>✓ 测试成功{testResult.durationMs != null ? ` (${testResult.durationMs}ms)` : ''}{testResult.url ? <> — <a href={testResult.url} target="_blank" rel="noreferrer" style={{ color: '#4ade80', wordBreak: 'break-all' }}>{testResult.url}</a></> : null}</span>
              : <span style={{ color: '#ef5b6e' }}>✖ 测试失败:{testResult.error}</span>}
          </div>
        ) : null}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: 'var(--muted)', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="并发上传数(1-6)。GitHub 等图床有 IP 速率限制,建议 ≤3。">
            并发: <input type="number" min={1} max={6} value={maxConcurrent} onChange={(e) => setMaxConcurrent(clampInt(e.target.value, 1, 6, 3))} style={{ ...inputCss, width: 56 }} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }} title="单 job 重试次数(0-5)。仅对 5xx/429/网络错重试,4xx 立即失败。">
            重试: <input type="number" min={0} max={5} value={maxRetries} onChange={(e) => setMaxRetries(clampInt(e.target.value, 0, 5, 2))} style={{ ...inputCss, width: 56 }} />
          </label>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <button type="button" onClick={() => void onTest()} disabled={testing || saving} title={`用 1×1 PNG 探测 ${backendLabel(tab)} 的签名/权限/域名`}>
            {testing ? '测试中…' : `🧪 测试 ${backendLabel(tab)}`}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} disabled={saving || testing}>取消</button>
            <button className="primary" onClick={() => void onSubmit()} disabled={saving || testing}>{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>
    </div>
  );
};

const Label: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'right' }}>{children}</span>
);
const Help: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--muted)', opacity: 0.85, marginTop: 4 }}>{children}</div>
);
