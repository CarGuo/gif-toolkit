#!/usr/bin/env node
/**
 * R-80 post-mortem · macOS dock tooltip / menubar 在 dev 下显示 "Electron"
 * ──────────────────────────────────────────────────────────────────────
 * Root cause:
 *   macOS Dock tooltip / Cmd-Tab name 不是由 Electron 的 `app.setName()`
 *   决定,而是由当前 process bundle 的 Info.plist 里
 *   `CFBundleName` / `CFBundleDisplayName` 决定。
 *   `node_modules/electron/dist/Electron.app/Contents/Info.plist`
 *   原始三处都写死 "Electron",所以 dev 模式起的进程被 Dock 当成 "Electron"。
 *   `app.setName()` 对 dock tooltip 无效,只影响 menubar 第一项名称。
 *
 * Fix (part 1 — name):
 *   每次 npm install / electron-rebuild 后,patch 这份 Info.plist:
 *     CFBundleName        = Gif Toolkit (dev)
 *     CFBundleDisplayName = Gif Toolkit (dev)
 *   保留 (dev) 后缀以便和打包产物区分。
 *
 * Fix (part 2 — about-panel icon, R-88):
 *   `app.setAboutPanelOptions({ iconPath })` 在 macOS 下被 AppKit
 *   忽略 — About 面板的 icon 来源是 `.app` bundle 内
 *   `Contents/Resources/<CFBundleIconFile>`,在 dev 模式下
 *   `CFBundleIconFile = electron.icns`(原子图标),所以无论
 *   主进程怎么配 iconPath,dev About 面板永远显示 Electron 原子。
 *   解决方案:把项目自己的 `build/icon.icns` 物理覆盖到
 *   `node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns`,
 *   这样 CFBundleIconFile 还指 electron.icns,但内容已经是品牌 logo,
 *   AppKit 渲染 About 面板时拿到的就是我们的 logo。
 *   打包产物不受影响:electron-builder 走 `mac.icon: build/icon.icns`
 *   生成自己的 .app,不依赖 dev 软链。
 *
 *   只在 darwin 跑(其他平台 noop);
 *   幂等(已 patched 直接 skip);
 *   挂在 `postinstall` 链尾,任何会重置 node_modules 的操作都会自动复位。
 *
 * Note:
 *   macOS 会缓存 LaunchServices / Dock 的 bundle 元数据,首次 patch 后
 *   可能需要重启 dev 才能看到效果(因为 Dock 是在进程启动时读 Info.plist)。
 *   `touch` Electron.app 让 LaunchServices 重新扫描。
 */

import {
  readFileSync,
  writeFileSync,
  statSync,
  utimesSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const APP_NAME = 'Gif Toolkit (dev)';
const PLIST_PATH = resolve(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/Info.plist',
);
const APP_PATH = resolve(process.cwd(), 'node_modules/electron/dist/Electron.app');
const PROJECT_ICNS = resolve(process.cwd(), 'build/icon.icns');
const ELECTRON_ICNS = resolve(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns',
);

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (!existsSync(PLIST_PATH)) {
  console.log(`[patch-electron-plist] skip: ${PLIST_PATH} not found`);
  process.exit(0);
}

let plist;
try {
  plist = readFileSync(PLIST_PATH, 'utf8');
} catch (e) {
  console.log(`[patch-electron-plist] skip: read failed (${e.message})`);
  process.exit(0);
}

const replaceTag = (key, value) => {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`, 'g');
  return plist.replace(re, (_, p1, _old, p3) => `${p1}${value}${p3}`);
};

const before = plist;
plist = replaceTag('CFBundleName', APP_NAME);
plist = replaceTag('CFBundleDisplayName', APP_NAME);

let plistChanged = plist !== before;
if (plistChanged) {
  try {
    writeFileSync(PLIST_PATH, plist, 'utf8');
    console.log(`[patch-electron-plist] patched plist: ${APP_NAME}`);
  } catch (e) {
    console.log(`[patch-electron-plist] write failed (${e.message}) — skip`);
    process.exit(0);
  }
} else {
  console.log(`[patch-electron-plist] plist already patched (CFBundleName=${APP_NAME}) — skip`);
}

// Part 2 — replace Electron's atom .icns with our brand .icns so the
// dev About panel shows the right logo. We compare mtimes to keep
// the operation idempotent: only re-copy if the project icns is
// newer than the bundled one (or if the bundled file is missing).
let icnsChanged = false;
if (existsSync(PROJECT_ICNS) && existsSync(ELECTRON_ICNS)) {
  try {
    const projStat = statSync(PROJECT_ICNS);
    const elecStat = statSync(ELECTRON_ICNS);
    // size differing OR project mtime newer ⇒ replace.
    if (projStat.size !== elecStat.size || projStat.mtimeMs > elecStat.mtimeMs) {
      copyFileSync(PROJECT_ICNS, ELECTRON_ICNS);
      icnsChanged = true;
      console.log(
        `[patch-electron-plist] replaced ${ELECTRON_ICNS} with project build/icon.icns`,
      );
    } else {
      console.log('[patch-electron-plist] electron.icns already matches project icns — skip');
    }
  } catch (e) {
    console.log(`[patch-electron-plist] icns copy failed (${e.message}) — skip`);
  }
} else if (!existsSync(PROJECT_ICNS)) {
  console.log(`[patch-electron-plist] no project icns at ${PROJECT_ICNS} — skip icon swap`);
}

// touch the .app so LaunchServices rescans the (possibly) new metadata.
if (plistChanged || icnsChanged) {
  try {
    statSync(APP_PATH);
    const now = new Date();
    utimesSync(APP_PATH, now, now);
  } catch {
    // ignore
  }
}
