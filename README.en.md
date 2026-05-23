<p align="center">
  <img src="./build/icon.png" alt="Gif Toolkit logo" width="160" />
</p>

<h1 align="center">Gif Toolkit</h1>

<p align="center">
  <b>Turn "fetch web media → fit the platform's hard limit → grab a Markdown link" into a few clicks.</b>
  <br/>
  Local, cross-platform, nothing leaves your machine. Works offline.
</p>

<p align="center">
  <b>English</b> · <a href="./README.md">简体中文</a>
  <br/><br/>
  <img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-1f6feb">
  <img alt="electron" src="https://img.shields.io/badge/Electron-31-2b3137">
  <img alt="react" src="https://img.shields.io/badge/React-18-149eca">
  <img alt="typescript" src="https://img.shields.io/badge/TypeScript-5-3178c6">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-2ea44f">
</p>

---

## What it solves

Anyone who ships GIFs into Slack, Discord, X, blogs or WeChat hits the same wall: every platform enforces its own hard cap (WeChat ≤ 10 MB AND ≤ 300 frames, Weibo ≤ 5 MB, Discord ≤ 8 MB ...). Hand-tuning side length, fps and palette every time is tedious and never reproducible.

Gif Toolkit automates the whole pipeline:

- Paste an article URL — **auto-sniff** every GIF / video / embed inside (Bilibili / YouTube / X / TikTok / Instagram, ...).
- **Video → GIF / WebP** with two-pass palette + Lanczos + Bayer dithering. Predictable quality.
- **Four-phase adaptive compression** lands the output between your "soft target" and "hard target". Never silently emits an over-budget file.
- One-click upload to your own host / GitHub / Qiniu / Aliyun OSS / Tencent COS — **auto-generates a Markdown link** ready to paste.

Everything runs locally. **Offline-friendly, no login, nothing sent to any third-party server.**

---

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/01-home.png" alt="Home: URL sniffer + media grid + options + task table" /></td>
    <td width="50%"><img src="./docs/images/screenshots/02-toolbox.png" alt="Toolbox: 10 sub-tools + drag area + options" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>Home</b> · paste URL → sniff → tick → batch</sub></td>
    <td align="center"><sub><b>Toolbox</b> · 10 standalone tools, drop a file and go</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/screenshots/03-history.png" alt="History tab: sniffs and outputs in one place" /></td>
    <td width="50%"><img src="./docs/images/screenshots/04-uploads.png" alt="Uploads tab: image-host log + Markdown copy" /></td>
  </tr>
  <tr>
    <td align="center"><sub><b>History</b> · every sniff / output / log archived</sub></td>
    <td align="center"><sub><b>Uploads</b> · 5 hosts + hash dedup + Markdown</sub></td>
  </tr>
</table>

---

## Quickstart

```bash
git clone <repo-url>
cd gif-toolkit
npm install     # auto-prepares ffmpeg / gifsicle / sharp / yt-dlp
npm run dev     # launch the app
```

Once the app is up:

1. Paste an article URL with GIFs / videos at the top, click **Sniff**.
2. Tick what you want in the media grid; tweak params (or pick a platform preset).
3. Click **Run batch**, wait for the task table; jump to **Uploads** to upload + copy the Markdown link.

### Packaging

```bash
npm run package:mac     # macOS: dmg + zip (Intel + Apple Silicon)
npm run package:win     # Windows: NSIS x64
npm run package:linux   # Linux: AppImage / deb / tar.gz
```

> About 5 s after launch, the app silently checks GitHub Releases and pops the **Check for updates** dialog if a strictly higher stable version is available. You can also trigger it manually from the top-right ⬆ button, the tray menu, or the macOS application menu.

---

## Install & first launch (what to do when it won't open)

Gif Toolkit is **not** Apple-notarized, **not** Authenticode-signed, and **not** Linux-package-signed — code signing is a paid legal commitment that does not pencil out for a single-author MIT project. So all three platforms will block the **first** launch with a "is this malware?" dialog. **This is expected, not a bug.** Follow the steps below to allow it.

### 🍎 macOS

#### What you see

> **"Gif Toolkit" is damaged and can't be opened. You should move it to the Trash.**

⚠️ **Do NOT click "Move to Trash".** The app is fine — Safari / Chrome stamped a `com.apple.quarantine` extended attribute on the download, and macOS Gatekeeper now blocks every unsigned binary that carries that flag.

#### Fix

Open **Terminal** (`/Applications/Utilities/Terminal.app`, or Spotlight ⌘+Space → "Terminal") and run:

```bash
xattr -cr "/Applications/Gif Toolkit.app"
```

> If the dmg is not in `/Applications` yet, drag the app there first.

Then double-click the app normally. The first run may show one more "unidentified developer" prompt — click **Open** once and you are done forever.

#### How it works

`xattr -cr` is **clear recursive**: it strips every extended attribute from every file inside the app bundle, including `com.apple.quarantine`. From macOS's point of view the app now looks like it was **not** downloaded from a browser. **The app's contents are untouched.**

#### "I already tried right-click → Open and it still won't open"

Old tutorials tell you to right-click → Open → confirm in the dialog. That path **stopped working** on **macOS Sequoia (15.0+)**:

| macOS version | Symptom | Working route |
| --- | --- | --- |
| ≤ 14.x (Sonoma) | "unidentified developer" gray button | Right-click → Open ✅ |
| 15.0 | "is damaged" dialog | Right-click is gone; **System Settings → Privacy & Security**, scroll to bottom, click **Open Anyway** |
| 15.1+ | "is damaged" dialog | Both right-click and the System Settings button are gone — **`xattr -cr` is the only path** |

So "right-click won't open it either" is Apple's design choice, **not a broken app**. On modern macOS, `xattr -cr "/Applications/Gif Toolkit.app"` is the only reliable way through.

#### Alternative: System Settings (only on macOS 15.0)

1. Double-click the app → see "is damaged" → click **Cancel** (never **Move to Trash**).
2. Open **System Settings** → **Privacy & Security**.
3. Scroll to the bottom, find `"Gif Toolkit" was blocked ...`, click **Open Anyway**.
4. Authenticate with Touch ID / password, then double-click the app again.

If step 3 doesn't show the prompt, you're on 15.1+ — use `xattr -cr` instead.

---

### 🪟 Windows

#### What you see

Big blue dialog when you double-click `Gif-Toolkit-1.0.0-win-x64.exe`:

> **Windows protected your PC**
>
> Microsoft Defender SmartScreen prevented an unrecognized app from starting. Running this app might put your PC at risk.

#### Fix

1. Click **More info**.
2. A new **Run anyway** button appears — click it.
3. The NSIS installer launches normally; install to `C:\GifToolkit`.

> SmartScreen scores executables by **download volume + signature reputation**. A freshly published unsigned installer scores 0; over time, reputation builds and the warning fades.

#### If antivirus deletes the exe outright

Some Chinese AV vendors (360 / 火绒) and certain Defender configurations are more aggressive against unsigned installers. Restore the file from **Quarantine / Trusted Zone**, **whitelist** it, or temporarily disable real-time protection just for the install. You can re-enable real-time protection afterwards — installed binaries are not re-scanned with the same aggression.

---

### 🐧 Linux

It depends on which artifact you downloaded:

#### AppImage (recommended, portable)

```bash
chmod +x Gif-Toolkit-1.0.0-linux-x86_64.AppImage
./Gif-Toolkit-1.0.0-linux-x86_64.AppImage
```

If you see `dlopen(): error loading libfuse.so.2`, the AppImage needs FUSE 2 but newer distros (Ubuntu 22.04+ / Fedora 36+) only ship FUSE 3. Install the compat package:

```bash
# Debian / Ubuntu
sudo apt install libfuse2

# Fedora
sudo dnf install fuse-libs

# Arch
sudo pacman -S fuse2
```

#### .deb (Debian / Ubuntu)

```bash
sudo apt install ./Gif-Toolkit-1.0.0-linux-amd64.deb
# Then from the app menu, or:
gif-toolkit
```

#### .tar.gz (any distro)

```bash
tar -xzf Gif-Toolkit-1.0.0-linux-x64.tar.gz
cd gif-toolkit-1.0.0
./gif-toolkit
```

#### Sandbox error: `SUID sandbox helper binary was found, but is not configured correctly`

Some distros (notably certain Ubuntu 24.04 configurations) restrict user namespaces, breaking Electron's sandbox. **Temporary** workaround:

```bash
./Gif-Toolkit-1.0.0-linux-x86_64.AppImage --no-sandbox
```

> ⚠️ `--no-sandbox` removes one layer of renderer-process isolation; use it only for troubleshooting. For a permanent fix, upgrade your kernel or install the `.deb` (the system package handles SUID permissions correctly).

---

### Why not just sign the binaries?

| Platform | Yearly cost (USD) | Notes |
| --- | --- | --- |
| Apple Developer Program (notarization) | $99 | Requires a USD credit card and a globally unique Team ID |
| Authenticode (OV cert) | ~$200 | Requires business-entity verification; EV certs are $300+ and need a USB hardware token |
| Linux | Free but fragmented | Each distro has its own signing expectations |

For an MIT solo-author project, **asking users to type one extra command** is a better trade-off than **paying every signing authority every year**. Should the project ever gain a corporate entity or sponsor, **macOS notarization will be the first to land** (largest UX win).

---

## Toolbox

The "Toolbox" tab gives you 10 standalone tools. Drop files onto any tool to batch-process them:

| Tool | Purpose |
| --- | --- |
| Video → GIF | Video to GIF + adaptive compression (ffmpeg / gifski engines) |
| Video → WebP | Video to animated WebP |
| GIF Resize | Proportional width resize |
| GIF Optimize | gifsicle `-O3` / lossy / colors / dither |
| GIF WeChat-safe | Three-step sanitize — output ships straight into WeChat (≤ 300 frames / clean header) |
| Trim | Time-range cut (lossless) |
| Speed | 0.25× ~ 4× |
| Reverse | Reverse playback |
| Rotate | Rotate + flip |
| Crop | Visual rectangle crop |
| GIF ↔ WebP | Convert between the two animated formats |

### Chained pipelines: feed the output back, step by step

Every `done` row in the toolbox history has a **Continue →** button. Click it and a dedicated **lineage modal** pops up, treating that output as the input of the next step:

![Chained pipeline modal](./docs/images/screenshots/05-toolbox-lineage-modal.png)

- A linear breadcrumb at the top (`Original → GIF Resize → GIF Optimize ...`); click any node to fork from there.
- Auto-playing preview of the current artifact (GIFs / WebPs use native loop; MP4 / WebM uses muted autoplay).
- Below: the next-step candidates filtered by extension, current params, and a **Trial 0.5 s** button — runs the first 0.5 s with current params so you can preview the effect (no history, no queue slot).
- ESC / outside click / "Exit lineage" closes the modal; the lineage itself is not lost — re-enter from any "Continue →".

### Quality-of-life shortcuts

![Target-bytes chip strip on GIF Optimize](./docs/images/screenshots/06-toolbox-target-bytes-chip.png)

- **Target-size chip strip on GIF Optimize**: `< 2 MB / < 5 MB / < 10 MB / Custom` — one click sets the threshold.
- **smart fps**: dropping a video defaults to `min(srcFps, 24)`, so high-fps sources do not get silently downsampled to film-rate.
- **Engine toggle on Video → GIF**: `Fast (ffmpeg)` / `High quality (gifski)` — gifski extracts a PNG sequence then encodes; richer color but slower.
- **Recommended presets on history cards**: cards with a video output (`.mp4 / .mov / .webm` etc.) show a `Convert · Fast` / `Convert · High quality` chip row — one click atomically switches to Toolbox, clears the queue, and enqueues the artifact.
- **Sniff card → Uploads jump**: the `☁ Uploaded N` pill on a sniff card is now clickable and lands you on the matching Uploads record.

![Recommended presets on a history card](./docs/images/screenshots/09-history-preset-strip.png)

---

## Five-tier sniffer cascade

Plain `axios + cheerio` cannot reach pages that need JS rendering, login cookies, or pages gated by Cloudflare's JA3 fingerprinting — exactly where the richest animated content lives. Gif Toolkit ramps up only when needed:

![Sniffer cascade](./docs/images/sniffer-cascade.png)

| Tier | Implementation | Best for |
| --- | --- | --- |
| (1) URL sniff | main-process axios + cheerio | Plain blogs / news pages / direct links / og:video |
| (2) Embedded WebView | `WebContentsView` + `webRequest.onBeforeRequest` | Pages that need login / cookies / OAuth / light interaction |
| (3) Real Chrome sniff | spawn local Chrome / Edge / Brave + CDP | Cloudflare / strict JA3 fingerprint sites |
| (4) yt-dlp direct | ytdlp-nodejs `--dump-single-json` | 1900+ video sites (Bilibili / YouTube / X / TikTok / Instagram ...) |
| (5) Offline import | `.mhtml` / `.html + _files/` / single file / drag-drop | Site went down / no network / saved-page archive |

> Implementation details in [docs/sniffer-cascade.md](./docs/sniffer-cascade.md) and [docs/sniffer-rules.md](./docs/sniffer-rules.md).

---

## Adaptive compression

Four-phase progressive strategy — typically ~12 gifsicle calls to land on target:

![Four-phase adaptive compression](./docs/images/compression-1-targets.png)

1. **Resize first** — clamp the long side to `maxWidth`.
2. **Adaptive lossy** — binary-search lossy ∈ `[0, 200]`, hit `softMaxBytes` (default 2 MB).
3. **Geometric shrink** — guard `minSize` floor on the short edge, multiply long side by 0.85 and retry.
4. **Bail** — still over `maxBytes` (default 4 MB) → mark `skipped`. **Never silently emit an over-budget file.**

WeChat additionally enforces two unrelated hard caps: **frames ≤ 300** and a **clean header**. The dedicated **WeChat-safe sanitize sub-pipeline** (gifsicle probe → ffmpeg full re-encode → gifsicle `-O0 --no-extensions --no-comments`) produces output that drops straight into the editor.

> State machine / hit conditions / WeChat-safe details in [docs/compression-pipeline.md](./docs/compression-pipeline.md).

---

## Image host upload

Five backends built in, configure many and switch on demand:

- **Custom Web** (custom signing endpoint)
- **GitHub Contents API**
- **Qiniu Kodo**
- **Aliyun OSS**
- **Tencent COS**

File-hash dedup (30-day TTL), reusing the remote URL when a file is unchanged. Markdown link is auto-generated. Tokens / secrets are masked end-to-end and **never written to logs**.

---

## Cross-platform

| Capability | macOS | Windows | Linux |
| --- | --- | --- | --- |
| Installer | dmg / zip (Intel + Apple Silicon) | NSIS x64 | AppImage / deb / tar.gz (x64 + arm64) |
| FFmpeg / Sharp / yt-dlp | Yes | Yes | Yes |
| Real Chrome sniff | Chrome / Canary / Edge / Brave / Chromium | Program Files / per-user paths | Snap / Flatpak / .deb / .rpm |
| App icon | `.icns` (10-tier iconset) | `.ico` (7 tiers) | `.png` 8 sizes |

---

## Security & privacy

- `contextIsolation=true` / `nodeIntegration=false` — the renderer has **no** Node capabilities.
- Only allow-listed IPC is exposed; downloads, parsing, transcoding, uploads all happen in the main process.
- URLs are processed locally and **never sent to any third-party server**.
- yt-dlp forwards an allow-list header set only; signed URLs / tokens are masked before logging.
- Backend tokens / secrets are shown as `••••••` with masked-merge on save; encrypted on persistence; **never logged**.

---

## FAQ

**Q: Why can't I sniff the direct video URL?**
A: Sites often check TLS fingerprint / cookies. Switch to **Real Chrome sniff** and tick "use my real Chrome profile" so Cloudflare etc. recognises you as a normal user.

**Q: My GIF still exceeds the target size — what now?**
A: The tool marks it `skipped` rather than emitting an over-budget file. Either raise `maxBytes`, or open the toolbox and re-compress with more aggressive lossy / colors.

**Q: WeChat still says "image failed to load"?**
A: Try the **GIF WeChat-safe** tool — it forcibly re-encodes frames, disables transdiff-offsetting, and emits via `gifsicle -O0`.

**Q: Can it run offline?**
A: Yes. yt-dlp / ffmpeg / gifsicle / sharp are all bundled. Only "sniff a remote URL" needs network.

---

## Docs & contributing

- Architecture, compression pipeline, sniffer cascade, IPC contract: see [docs/](./docs/).
- Engineering harness (rules / scenarios / checklists): see [harness/](./harness/).
- Submission rules and PR self-check: [AGENTS.md](./AGENTS.md) + [harness/checklists/pr-checklist.md](./harness/checklists/pr-checklist.md).

Test tiers (developer-facing):

```bash
npm run test:fast        # vitest unit suite, ~6s
npm run test:e2e:smoke   # real Electron + mock-oss single chain, ~10s
npm run test:e2e         # full 122 cases, ~1.5min
```

Every new feature / bug fix must ship with tests.

---

## Acknowledgements

- [ezgif.com](https://ezgif.com/) — original feature & UX reference
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) — de-facto standard for direct-link extraction
- [ffmpeg](https://ffmpeg.org/) / [gifsicle](https://www.lcdf.org/gifsicle/) / [sharp](https://sharp.pixelplumbing.com/) — the three pillars of video & GIF processing

---

## License

MIT
