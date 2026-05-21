<p align="center">
  <img src="./build/icon.png" alt="Gif Toolkit logo" width="128" />
</p>

<h1 align="center">Gif Toolkit</h1>

<p align="center">
  <b>English</b> · <a href="./README.md">简体中文</a>
</p>

<p align="center">
  <b>Cross-platform desktop app · macOS / Windows / Linux</b><br/>
  A one-stop pipeline that goes <b>scrape → video-to-GIF/WebP → adaptive compression → image hosting upload</b>,<br/>
  turning "feed me an article URL, give me a set of size-compliant GIFs and a ready-to-paste Markdown snippet" into a few clicks.
</p>

Gif Toolkit solves a very specific pain point — every content platform enforces strict size caps on animated images (WeChat MP ≤ 10 MB, Slack / Weibo ≤ 5 MB, Discord ≤ 8 MB, …), and manually tweaking dimensions, frame rate, and palette is tedious. This tool automates the whole chain. **It runs offline, requires no login, and never uploads any data to third-party servers.**

---

## 📸 Screenshots

<table>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/01-home.png" alt="Home: URL sniff + media grid + options + task table" /></td>
    <td width="50%"><img src="./docs/images/screenshots/02-toolbox.png" alt="Toolbox: 9 sub-tools + drop zone + params + history" /></td>
  </tr>
  <tr>
    <td align="center"><sub>① Home: URL → Sniff → Media grid → Batch</sub></td>
    <td align="center"><sub>② Toolbox: Video→GIF / WebP / Optimize / Trim / Crop …</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/03-history.png" alt="History tab: sniff + artifact history in one place" /></td>
    <td width="50%"><img src="./docs/images/screenshots/04-uploads.png" alt="Upload history tab: hosting records + Markdown copy" /></td>
  </tr>
  <tr>
    <td align="center"><sub>③ History: every sniff round + artifacts + logs persisted</sub></td>
    <td align="center"><sub>④ Upload history: 5 backends + hash dedup + Markdown</sub></td>
  </tr>
</table>

---

## ✨ Highlights

### 🔍 One-click scraping
- Paste any page URL; the tool detects GIFs, videos, and embedded players (YouTube / Bilibili / Vimeo / X / TikTok / Instagram, …).
- Four scraping modes, ordered by anti-bot resistance:
  - **Plain URL scrape** — fastest path, ideal for blogs, news sites, direct links.
  - **Embedded WebView** — handles login / interaction-required sites.
  - **Real Chrome** — drives your installed Chrome / Edge / Brave to bypass Cloudflare-class bot walls.
  - **yt-dlp direct** — covers 1900+ video sites without launching any browser.
- **Offline import**: `.mhtml`, `.html + _files/`, single files, or drag-and-drop. Works even if the original site is offline.

### 🎞️ Video → GIF / animated WebP
- Two-pass `palettegen + paletteuse` + Lanczos scaling + Bayer dithering for stable visual quality.
- Timeline preview with key-frame thumbnails; drag handles to pick a segment; freely drag a crop rectangle on the source frame.
- Long videos are auto-segmented; you can tick 0–20s / 20–40s / … and export each as a separate GIF.

### ⚙️ Adaptive compression pipeline
A four-phase progressive strategy. On average ~12 gifsicle invocations are enough to land on the target size:

1. **Resize first** — clamp the long edge to `maxWidth`.
2. **Adaptive lossy** — binary-search lossy levels, aiming for `softMaxBytes` (default 2 MB).
3. **Geometric shrink** — keep short edge ≥ floor while progressively reducing resolution.
4. **Fallback** — if it still exceeds `maxBytes`, mark the task `skipped` instead of emitting an over-sized file.

Tunable knobs include `maxBytes` / `softMaxBytes` / `maxWidth` / `minSize` / `fps` / `colors` / `concurrency` / `maxSegmentSec`. Built-in presets cover WeChat MP, Zhihu, Weibo, etc.

### 🧰 GIF / WebP toolbox
The "Toolbox" tab offers 10 standalone tools that work on any local file you drop in:

| Tool | Purpose |
| --- | --- |
| Video → GIF | Convert + compress |
| Video → WebP | Convert to animated WebP |
| GIF Resize | Proportional width scaling |
| GIF Optimize | gifsicle `-O3` / lossy / colors / dither |
| Trim | Lossless time-range cut |
| Speed | 0.25× – 4× playback speed |
| Reverse | Play in reverse |
| Rotate | Rotate + flip |
| Crop | Visual crop selector |
| GIF ↔ WebP | Convert between animated formats |

### 📦 Batch processing + history
- Single-click batch run from the home screen, with the ability to enqueue more while a batch is running. Long videos surface a confirmation modal listing each segment.
- Scrape and processing history are persisted to SQLite. You can re-run a single item or a whole batch, open the output directory, and inspect the artifact list.
- Each run keeps a complete operation log that can be exported to `.log` or `.json`. This makes "why did it fail to compress?" or "why are there duplicates?" easy to audit.

### ☁️ Image hosting upload
Five built-in backends, configurable in parallel:

- **Self-hosted Web** (custom signed endpoint)
- **GitHub Contents API**
- **Qiniu Kodo**
- **Aliyun OSS**
- **Tencent COS**

A SHA-256 hash cache (30-day TTL) reuses the previously uploaded URL when the same file hits the same backend, saving bandwidth and quota. After upload the tool generates Markdown snippets that you can paste straight into your article. All tokens / secrets are masked in the UI and **never written to logs**.

### 🌐 Cross-platform support

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Installer | ✅ dmg / zip (Intel + Apple Silicon) | ✅ NSIS x64 | ⚠️ AppImage / deb / tar.gz (x64 + arm64, not yet validated on real hardware) |
| FFmpeg / Sharp / yt-dlp | ✅ | ✅ | ✅ (armv7 / Alpine musl require manual setup) |
| Real-Chrome scrape | ✅ Chrome / Canary / Edge / Brave / Chromium | ✅ Program Files / per-user paths | ⚠️ Includes Snap / Flatpak / .deb / .rpm |
| Startup capability probe | ✅ | ✅ | ✅ |

> Apple notarization, Authenticode signing, and Linux code signing are not configured yet. On first launch you may need to right-click → Open (macOS) or skip SmartScreen (Windows); the app surfaces platform-specific instructions via toasts.

---

## 🚀 Getting started

### End users (prebuilt)

> No official release is published yet. Build from source per the section below.

### Run from source

```bash
git clone <repo-url>
cd gif-toolkit
npm install            # Pulls ffmpeg / gifsicle / sharp / yt-dlp binaries
npm run dev            # Dev mode (main + renderer with hot reload)
```

### Package

```bash
npm run package:mac    # macOS: dmg + zip (Intel + Apple Silicon)
npm run package:win    # Windows: NSIS x64
npm run package:linux  # Linux: AppImage / deb / tar.gz
```

### Workflow

1. Launch the app and paste a URL containing GIFs / videos into the address bar.
2. Pick a scrape mode (the default "Plain URL" works for most blogs) and click **Start Sniff**.
3. Tick the desired media in the grid, adjust `maxWidth` / `softMaxBytes` etc. if needed.
4. Click **Start Process** and wait for the task table to drain.
5. Configure an image-hosting backend in the "Upload History" tab, then click **⚡ Upload all artifacts** and copy the generated Markdown link.

---

## 🛠️ Tech stack

| Layer | Tech |
| --- | --- |
| Framework | Electron 31 + React 18 + TypeScript 5 + Vite 5 |
| Scraping | axios + cheerio (main process, no CORS limits) |
| Video processing | ffmpeg-static + ffprobe-static + sharp 0.33 |
| GIF optimization | gifsicle 5.3 |
| Direct-link resolver | yt-dlp (bundled, Unlicense) |
| Persistence | better-sqlite3 |
| Queue | p-queue (default concurrency 3, configurable 1–8) |
| Tests | vitest + happy-dom + @testing-library/react |

---

## 🔒 Security & privacy

- `contextIsolation=true` and `nodeIntegration=false` — the renderer has no Node access.
- Only an explicit IPC whitelist is exposed; downloads, parsing, transcoding, and uploads happen in the main process.
- Every URL is processed locally. **Nothing is sent to third-party servers.**
- yt-dlp link resolution forwards only a whitelist of headers (User-Agent / Referer / Origin / Range, …); Authorization / Cookie are never passed through. Signed URLs and tokens are redacted before any log line is written.
- Backend tokens / secrets render as `••••••` in the UI with masked-merge persistence and **never appear in logs**.

---

## ❓ FAQ

**Q: Why does direct-link scraping fail on some sites?**
A: Some sites do TLS / cookie fingerprinting against unauthenticated devices. Switch to "Real Chrome" mode and tick "Use my real Chrome profile" so Cloudflare-class systems treat you as a normal user.

**Q: My GIF still exceeds the size target — what now?**
A: The pipeline marks the task `skipped` rather than emitting an oversized file. You can raise `maxBytes`, or use the toolbox to manually re-compress with more aggressive lossy / colors settings.

**Q: Can I use it offline?**
A: Yes. yt-dlp, ffmpeg, gifsicle, and sharp ship with the app. Only the "scrape an online URL" step itself needs the network.

**Q: Do GitHub-hosted images count as code?**
A: No. GitHub Contents API returns raw image URLs you can drop straight into Markdown without affecting the repository code.

---

## 🏗️ Architecture

Process topology (Renderer ↔ Preload ↔ Main):

![Architecture · process topology](./docs/images/architecture-1-topology.png)

End-to-end data flow (URL → sniff → 4-Phase compression → artifacts):

![Architecture · end-to-end data flow](./docs/images/architecture-2-dataflow.png)

> Every architecture diagram is a derived PNG generated from a mermaid source. To edit, change the mermaid block in [docs/architecture.md](./docs/architecture.md) and run `npm run docs:render` to re-export the PNG.

---

## 📚 Documentation

For developers / contributors:

- [Architecture overview](./docs/architecture.md)
- [Compression pipeline](./docs/compression-pipeline.md)
- [Sniffer cascade](./docs/sniffer-cascade.md)
- [Sniffer rules](./docs/sniffer-rules.md)
- [yt-dlp embed resolver](./docs/embed-resolver.md)
- [IPC contract](./docs/ipc-contract.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [SQLite persistence & native ABI](./docs/R-80-SQLITE-NOTES.md)

Engineering discipline (rules / scenarios / checklists): see the [harness/](./harness/) directory.
Contribution norms: [AGENTS.md](./AGENTS.md).

---

## 🤝 Contributing

Issues / PRs are welcome. Before submitting, please read:

1. [AGENTS.md](./AGENTS.md) — project-wide hard rules.
2. [harness/checklists/pr-checklist.md](./harness/checklists/pr-checklist.md) — pre-submit checklist.
3. [harness/scenarios/](./harness/scenarios/) — accumulated regression scenarios.

Every new feature or bug fix must ship with corresponding tests.

---

## Acknowledgements

- [ezgif.com](https://ezgif.com/) — original feature / interaction reference
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — de-facto standard for direct-link resolution
- [ffmpeg](https://ffmpeg.org/) / [gifsicle](https://www.lcdf.org/gifsicle/) / [sharp](https://sharp.pixelplumbing.com/) — the video & GIF processing trio

---

## License

MIT
