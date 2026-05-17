# Sniffer Cascade — 四档嗅探链路(R-44 → R-53)

> 这份文档描述 Gif Toolkit 把"哪些 URL 能嗅出哪些媒体"这个问题切成了 4 档独立通路。
> 关于 7 类 DOM 规则本身,参见 [sniffer-rules.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/sniffer-rules.md)。
> 关于 yt-dlp resolver 的下载侧细节,参见 [embed-resolver.md](file:///Users/guoshuyu/workspace/gif-toolkit/docs/embed-resolver.md)。

---

## 为什么需要 4 档

ezgif.com 的策略是"我替你后端把站点抓了再吐 URL",但要做到桌面 App 必须替代后端,而单一抓法注定碰壁:

| 阻碍 | 单纯 axios+cheerio 行不行 | 嵌入式 webview 行不行 | 真 Chrome 行不行 | yt-dlp 行不行 |
|---|---|---|---|---|
| 普通静态页 / 直链 | ✅ 最快 | ⛔ 启动慢 | ⛔ 启动慢 | ⛔ 不识别非视频站 |
| 需要登录 / OAuth / 交互 | ⛔ 跳 401 | ✅ 真用户操作 | ✅ 真用户操作 | ⛔ |
| Cloudflare Turnstile / JA3/JA4 严校验 | ⛔ TLS 直接拒 | ⛔ Electron 自带 Chromium 指纹被识破 | ✅ 真浏览器指纹 | ⛔ 同上 |
| YouTube / X / B站 / TikTok 视频 | ⛔ 抓 HTML 没 src | ⏳ 慢 + 偶尔失败 | ⏳ 慢 | ✅ 1900+ extractor |

所以工具栏的「网页嗅探」是一个 **split-button**:左主按钮跑用户上次选择的模式,右 ▾ 切换。纯 URL 嗅探作为最快路径默认始终通过输入框旁的「开始嗅探」按钮触发。

---

## 通路 ①  纯 URL 嗅探(默认)

- IPC: `sniff:url`
- 实现:[src/main/sniffer.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts) 主进程 axios + cheerio
- 触发:输入框 → `开始嗅探`
- 适合:普通博客 / 新闻页 / 已知直链 / og:video 暴露的页面
- 不适合:任何需要登录、JS 渲染才能看到 src 的页面

---

## 通路 ②  嵌入式 webview 嗅探(R-44 / R-47 / R-49 / R-50)

- IPC: `sniff:webview`
- 实现:[src/main/webviewSniff.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/webviewSniff.ts)
- 触发:split-button 左(若为该档) / 菜单 ①
- 适合:需要登录 / Cookie / OAuth / 交互但 TLS 不严的站
- 不适合:Cloudflare 严校验的站(JA3/JA4 检测会拦下 Electron Chromium)

工程要点:
- `WebContentsView` 内嵌 + chrome-shell HTML 工具栏(用户可前进 / 后退 / 关闭)
- `webRequest.onBeforeRequest` 监听所有请求 → 命中 `media-types` allowlist 就 capture
- 用户完成交互点 `完成嗅探` → DOM 扫描(R-50)合并结果
- R-49 同 partition 的 `attachHeaderSpoofer` 把 sec-ch-ua / Accept-Language 改成真实 Chrome 形态,避免某些站点用 client-hints 兜底拦
- R-48 性能旗:`backgroundThrottling: false` + `spellcheck: false` + `v8CacheOptions: 'code'`

R-53 加固:
- `openWebviewSniff(url, parent, { signal })` 接受外部 AbortSignal,任何切换会触发 `finish('cancel')` 强制销毁窗口

---

## 通路 ③  真 Chrome 嗅探(R-51)

- IPC: `sniff:system-chrome`
- 实现:[src/main/systemChromeSniff.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/systemChromeSniff.ts)
- 触发:split-button 左(若为该档) / 菜单 ②
- 适合:OpenAI / Medium / Patreon 等 Cloudflare TLS-JA3/JA4 + Turnstile 严防站
- 不适合:小机器(Chrome 启动开销大)/ 用户没装 Chrome / Edge / Brave

工程要点:
- 用 [pickSystemChrome.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/pickSystemChrome.ts) 寻找用户机器上的 Chrome / Edge / Brave 之一
- `child_process.spawn(exe, ['--remote-debugging-port=0', '--user-data-dir=<isolated>', url, ...])`
- 轮询 `<userDataDir>/DevToolsActivePort` 取动态端口 → `chrome-remote-interface` 连 CDP
- CDP 订阅 `Network.responseReceived` + `Page.frameNavigated` 抓媒体 + `Runtime.evaluate` 跑 DOM 扫描
- 用户在真 Chrome 里通过 Turnstile / 登录后关闭窗口即返回结果

R-53 加固:
- 启动前清 `DevToolsActivePort` / `SingletonLock` / `SingletonCookie` / `SingletonSocket`,防止上一次硬杀进程留的锁
- cleanup 走 SIGTERM → 1.5 s SIGKILL 兜底,清完再删 Singleton 文件,下次同 profile 能继续用
- `waitForDevToolsPort` 内部 `child.once('exit', onExit)` 改成命名函数 + cleanup 解绑,防长 session Chrome 退出回调撞已 settle 的 Promise

R-55 Fix #2 加固(2026-05-17):
- 加 `SniffOpts.finalizeSignal: AbortSignal`,renderer 调 `giftk.finalizeSystemChromeSniff()` 触发它,让等 `child.exit` 的 Promise 第三种 resolve 路径(`finalizedByUser=true` 走完整 DOM scan,语义=success 不是 abort)
- 解决「本机已开 Chrome,新 spawn 实例瞬间合并 → 关 tab 不触发 child.exit → 卡 60%」
- main 多并列一根 `currentSystemChromeFinalizeCtrl: AbortController`(独立于 `currentSniffCtrl`)
- 60% message 在 renderer 升级为橙色脉冲 banner(`@keyframes sniff-pulse`),并在右侧渲染绿色「✓ 完成嗅探」按钮(只在 `activeSniffMode === 'system-chrome'` 时显示)


---

## 通路 ④  yt-dlp 直接抓(R-52)

- IPC: `sniff:ytdlp-direct`
- 实现:[src/main/ytdlpDirectSniff.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/ytdlpDirectSniff.ts)
- 触发:split-button 左(若为该档) / 菜单 ③
- 适合:YouTube / X / Bilibili / TikTok / Reddit / 推特 / 1900+ 已识别视频站
- 不适合:任意网页都试一遍(`Unsupported URL` 会立刻给中文 fallback 提示)

工程要点:
- 不打开任何浏览器,URL → `yt-dlp --dump-single-json` → JSON 解析 → 单条 `SniffedMedia`
- ID 用 `shortHash(pageUrl)` 而不是 `resolved.url`(R-53 Fix #6),CDN token 旋转后仍然是同一条
- mime 守卫:`ext ∈ {mp4,webm,mov,m4v,mkv,avi,flv,3gp,ts}` 才用扩展名拼 mime,否则统一 `video/mp4`,避免 storyboard `video/jpg` 噪声

R-53 加固:
- `resolveDirectUrl(url, signal)` 用 `child_process.spawn` 自管子进程,**真透传 AbortSignal**:abort → SIGTERM,1 s 后未退则 SIGKILL
- stdout 32 MB cap + stderr 256 KB cap,防恶意/异常 JSON 撑爆内存
- `classifyYtdlpError(err)` 6 档错误分类,UI 给中文人话:
  - `not-installed`:"yt-dlp 未安装"
  - `aborted`:"用户取消"
  - `login-wall`:命中 `sign in|private video|members[- ]only|age[- ]restricted|geo[- ]restricted|confirm you're not a bot`
  - `rate-limit`:命中 `HTTP Error 429|HTTP Error 403|too many requests|throttle|rate.?limit`
  - `network`:命中 `getaddrinfo|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|TLS|SSL`
  - `unsupported`:命中 `Unsupported URL|no playable format|Requested format is not available`

---

## 通路 ⑤  离线导入(R-55 Fix #3)

- IPC: `sniff:offlineImport`
- 实现:[src/main/offlineImport.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/offlineImport.ts)
- 触发:URL 栏右侧「📂 离线导入」按钮 / 任意位置拖拽文件入窗
- 适合:Cloudflare 死锁 / 登录墙 / GFW 不通,但你已经手动把页面 / 文件存到了本地的兜底
- 三种输入形态:
  1. `.mhtml / .mht`(Chrome / Edge「网页,单一文件」)— 解析 RFC 2557 multipart/related,把每个 part 落到 `os.tmpdir()/giftk-mhtml-*`,然后把主 html 里的引用按 `Content-Location` 重写成 `file://`
  2. `.html / .htm`(可带兄弟 `_files/` 目录,即 Chrome「网页,完整」)— 把所在目录当 base,相对 src 解析为 `file://`(不存在则丢弃 + warning)
  3. 单 `.mp4 / .webm / .mov / .gif / .png / .jpg / .webp / ...` — 直接合成一条 `SniffedMedia`
- 安全:`resolveOfflineRef` 拒绝 parent traversal(`../`)与绝对系统路径(`/etc/...`),只允许 baseDir 子树
- 单测:[tests/main/offlineImport.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/offlineImport.test.ts) 12 条覆盖三种形态 + 防穿越 + 缺失资源 + boundary 缺失

---

## 共享底座(R-53)

### Single-flight & abort 透传

四档全部共享 [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 的 `currentSniffCtrl: AbortController | null`:

```
let currentSniffCtrl: AbortController | null = null;

ipcMain.handle('sniff:<mode>', async (_e, url) => {
  if (currentSniffCtrl) { try { currentSniffCtrl.abort(); } catch {} }
  const ctrl = new AbortController();
  currentSniffCtrl = ctrl;
  try { return await runMode<...>(safe, { signal: ctrl.signal }); }
  finally { if (currentSniffCtrl === ctrl) currentSniffCtrl = null; }
});
```

切换任一档会先 `abort()` 上一次的 in-flight 操作,孤儿 webview / 真 Chrome / yt-dlp 子进程都会被强制收回。这条规则同时关掉了 R-52 评估清单里 race A:**先点 webview,再点 yt-dlp,前一个窗口不再泄漏。**

### 入口安全(R-53 Fix #4)

四档入口前先过 `ensurePublicHttp(url)`:

- 拒绝 `file://` / `javascript:` / 任何非 http(s) 协议
- 拒绝私有网段 / `localhost` / `0.0.0.0` / link-local

`SniffedMedia.source` 必须命中 [src/shared/headers.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/headers.ts) 的 `SNIFFED_MEDIA_SOURCES`(单一真源,与类型联合 1:1),否则 `sanitizeMedia` 直接 throw。

### Header allowlist 单一真源(R-53 Fix #5)

[src/shared/headers.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/headers.ts) 唯一定义:

- `RESOLVED_HEADER_ALLOWLIST`:9 项 — 解析后下载用的 header(`User-Agent / Referer / Origin / Accept / Accept-Language / Range / X-CSRF-Token / X-Requested-With / Cookie-Free`,严格无 Authorization / Cookie / Set-Cookie / Host)
- `SNIFFED_MEDIA_SOURCES`:10 项 — 与 `SniffedMedia.source` 类型联合 1:1
- `sanitizeAllowlistedHeaders(h)`:工具函数

主进程 [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 与 [src/main/resolver/ytdlp.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/resolver/ytdlp.ts) 都从这里 import,杜绝以前两处散布 Set 编译期漂移的隐患。

### a11y(R-53 Fix #3)

split-button 菜单 [src/renderer/App.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/App.tsx):

- `role="menuitemradio"` + `aria-checked={isSelected}` + `aria-haspopup="menu"` + `aria-expanded`
- `tabIndex` 只在选中项 = 0,非选中 = -1(roving tab index)
- ArrowDown / ArrowUp / Home / End 键盘导航
- Esc 关闭 + 焦点回到 caret 按钮
- mousedown 在菜单/caret 之外 → 关闭(替代不可靠的 onMouseLeave)
- 打开时焦点跳到当前选中项,用户立刻知道自己在哪
