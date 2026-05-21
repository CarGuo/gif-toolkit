# R-87 — Tmp cleanup guardrails (误删红线)

**Status**: ratified · **Source**: 第 73 轮用户指令
"测试生成的文件要自己学会删掉啊,现在保留了一堆测试的,当然要避免误删"

## 一句话

任何由本项目生成、且可能被遗弃在系统 tmp 的目录,必须在
**白名单 + tmpdir-jail + dryRun 默认** 三道护栏下被一次性 sweep,
**绝不允许**根据扩展名 / 大小 / 最近时间这种"模糊匹配"去删。

## 实现位置

- [src/main/tmpCleanup.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/tmpCleanup.ts):
  - `ALLOWED_PREFIXES`(白名单常量,所有受控前缀的唯一来源)。
  - `listStaleEntries(items, now, prefixes, maxAgeMs)`:**纯函数**,
    不读时钟、不读盘,易测。
  - `sweepTmpDir({ tmpDir, maxAgeMs?, dryRun?, logger? })`:薄 IO 入口,
    返回 `{ scanned, deleted, skipped, errors[] }`。
  - `sessionTmpRegistry`:`registerSession(p)` / `forgetSession(p)` /
    `cleanupSessionSync()`,防止 sweep 误删本会话仍在使用的 staged 资源。
- [scripts/clean-tmp.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/clean-tmp.mjs):CLI 入口,默认 `--dry-run`,
  `--apply` 才动手,`--max-age-h` 自定义。
- [src/main/offlineImport.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/offlineImport.ts) L576:`mkdtempSync` 改造为
  失败 `fs.rmSync(stagedDir,{recursive:true,force:true})`,成功
  `sessionTmpRegistry.registerSession(stagedDir)`。
- [src/main/index.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) `whenReady` 末尾 `setTimeout(...,5000)`
  调一次 `sweepTmpDir`;`before-quit` 头部 `cleanupSessionSync()`。

## 白名单(ALLOWED_PREFIXES)

```
giftk-mhtml-          ← offlineImport mhtml staging
giftk-offline-test-   ← offlineImport unit test fixtures
giftk-e2e-            ← e2e harness scratch
giftk-in-             ← processor input scratch
giftk-out-            ← processor output scratch
giftk-fake-           ← test mock scratch
```

新增前缀必须**先改这个常量**,sweep 才认。

## 三道护栏

1. **前缀白名单** — `entry.name` 必须 `startsWith` 白名单中至少一条,
   否则跳过(不算入 deleted、也不算 errors)。
2. **tmpdir-jail** — `tmpDir` 必须是 `os.tmpdir()` 或其下子目录;
   `path.relative(os.tmpdir(), tmpDir)` 不得 `startsWith('..')`。
   入口处直接抛错,绝不允许传入 `/`、`/home`、`process.cwd()` 这类
   越界根目录。
3. **dryRun 默认** — CLI 默认只打印计划,不删盘。`--apply` 显式开关
   才真删;主进程内置 sweep 在生产代码里强制 `dryRun: false`,但被
   前两道护栏夹住,误删红线在常量级别杜绝。

附加保障:

- **liveSession 跳过** — `sessionTmpRegistry` 注册过的路径,sweep 阶段
  归入 `skipped`,绝不删。
- **mtime 阈值** — 默认 24h,覆盖最长一次离线导入会话长度。
- **ENOENT 不算错** — 并发条件下另一进程已删,正常吞掉。

## 红线(NEVER)

- **不准**用 `rm -rf` / `glob` / shell pipe 实现 sweep —— 必须走
  `fs.rmSync(target, { recursive:true, force:true })`,且 `target` 必经
  上述三道护栏。
- **不准**把白名单做成"支持通配符" / "支持正则" —— 维持纯 `startsWith`,
  让审计成本恒为 O(白名单长度)。
- **不准**在 `before-quit` 之外 / 主进程外的任意位置调 `sweepTmpDir`(
  唯一例外:CLI [scripts/clean-tmp.mjs](file:///Users/guoshuyu/workspace/gif-toolkit/scripts/clean-tmp.mjs))。

## 验收

- [tests/main/tmpCleanup.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/tmpCleanup.test.ts) 12/12 用例:前缀白名单 / mtime 阈值 /
  dryRun / ENOENT / 越界拒绝 / live session 跳过。
- SC-22 误删护栏冒烟:[SC-22-tmp-cleanup-guardrails.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-22-tmp-cleanup-guardrails.md)。
- 手工 `ls $TMPDIR | grep giftk-` 应在启动后 5s 内归零(超过 24h 的旧目录)。
