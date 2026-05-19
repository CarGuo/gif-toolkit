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
 * Fix:
 *   每次 npm install / electron-rebuild 后,patch 这份 Info.plist:
 *     CFBundleName        = Gif Toolkit (dev)
 *     CFBundleDisplayName = Gif Toolkit (dev)
 *   保留 (dev) 后缀以便和打包产物区分。
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

import { readFileSync, writeFileSync, statSync, utimesSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const APP_NAME = 'Gif Toolkit (dev)';
const PLIST_PATH = resolve(
  process.cwd(),
  'node_modules/electron/dist/Electron.app/Contents/Info.plist',
);
const APP_PATH = resolve(process.cwd(), 'node_modules/electron/dist/Electron.app');

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

if (plist === before) {
  console.log(`[patch-electron-plist] already patched (CFBundleName=${APP_NAME}) — skip`);
  process.exit(0);
}

try {
  writeFileSync(PLIST_PATH, plist, 'utf8');
  const now = new Date();
  try {
    const st = statSync(APP_PATH);
    utimesSync(APP_PATH, now, now);
  } catch {
    // ignore
  }
  console.log(`[patch-electron-plist] patched: ${APP_NAME}`);
} catch (e) {
  console.log(`[patch-electron-plist] write failed (${e.message}) — skip`);
  process.exit(0);
}
