# SC-12 — gifsicle must be CommonJS-loadable (no ERR_REQUIRE_ESM)

## 输入
- `require('gifsicle')` 在 Electron 主进程同步 require。
- App.whenReady 后调 `printPaths()`。

## 期望
- `gifsicle@^4.0.1` 能直接 `require()` 拿到字符串(或 `{ default: string }`,二者都做兼容)。
- `printPaths()` 输出三段日志:
  ```
  binaries: ffmpeg=... ok=true ffmpeg version 6.x ...
  binaries: ffprobe=... ok=true ffprobe version 4.x ...
  binaries: gifsicle=... ok=true LCDF Gifsicle 1.88
  ```
- `app.isPackaged` 时把 `app.asar` 自动改写到 `app.asar.unpacked`。

## 验证脚本
```bash
./node_modules/.bin/electron /tmp/giftk-binaries-probe.js
# 退出码 0,且 PROBE_RESULT 三个 ok 全 true。
```

## 关联代码
- [getGifsiclePath](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts)
- [printPaths probe](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/binaries.ts)
- [package.json gifsicle pin](file:///Users/guoshuyu/workspace/gif-toolkit/package.json)

## 反例
- ❌ `gifsicle@^5.x` 是 ESM,在 CommonJS 主进程会 `ERR_REQUIRE_ESM`,所有 GIF 任务直接挂。
- ❌ 不做 `printPaths()` 自检 — 用户安装失败时只看到模糊错误,不知道是哪个二进制坏了。
