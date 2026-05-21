# SC-22 — Tmp cleanup 误删护栏 / never delete unrelated dirs

> **来源**:第 73 轮用户指令"测试生成的文件要自己学会删掉啊,当然要避免误删"。
> **关联规则**:[R-87](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-87-tmp-cleanup-guardrails.md) [R-12](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-12-do-not-evade-tests.md) [R-16](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/R-16-tests-required.md)

---

## 触发条件

| 场景 | 期望 |
|---|---|
| `$TMPDIR/random-other-app/` 与 `$TMPDIR/giftk-mhtml-abc/` 并存 | 只动 `giftk-mhtml-abc/`,前者 untouched |
| `$TMPDIR/giftk-mhtml-fresh/` mtime 30 分钟前 | mtime < 24h → skip |
| `$TMPDIR/giftk-mhtml-stale/` mtime 5 天前 | mtime > 24h → delete |
| `sweepTmpDir({ tmpDir: '/' })` 被恶意/手滑传入 | tmpdir-jail 抛错,无任何 fs 改动 |
| `sweepTmpDir({ tmpDir: process.cwd() })` 误用 | 同上,抛错 |
| dryRun=true(CLI 默认) | 计划列表写入 `deleted[]`,但 `fs.rmSync` 必须**未被调用** |
| 一个 staged 目录已 `sessionTmpRegistry.registerSession(p)` | sweep 阶段归 `skipped`,不删 |

---

## 期望行为

1. **白名单是唯一接受清理的判据**:`ALLOWED_PREFIXES` 之外的目录,不论 mtime 多旧、不论是否空目录,**绝不删**。
2. **tmpdir-jail 必须在入口处校验**:`path.relative(os.tmpdir(), tmpDir)` startsWith `'..'` → throw `'tmpDir must be inside os.tmpdir()'`,无任何 readdir。
3. **dryRun 必须只走 listStaleEntries 路径**,不调 `fs.rmSync`(单测里 spy 验证 0 次)。
4. **ENOENT 不算错**:并发条件下另一进程已删 → swallow,继续下一个。
5. **liveSession 跳过**:只要本会话注册过的路径,sweep 阶段必跳。

---

## 反向断言

- 不允许任何一种"模糊匹配"清理策略:不能按"含 giftk 字眼"、"以 .tmp 结尾"、"<1MB"等条件去删。
- 不允许在 main 进程外 require `tmpCleanup.ts`(防止 renderer 拿到 fs 副作用入口)。
- 不允许将 `ALLOWED_PREFIXES` 设计成可外部传入的参数 —— 本意就是让审计成本恒为 O(白名单长度)。
- 不允许 sweep 报错(ENOENT 之外)被 swallow:必须 push 到 `errors[]` 让 caller log。

---

## 验收 checklist

- [ ] [tests/main/tmpCleanup.test.ts](file:///Users/guoshuyu/workspace/gif-toolkit/tests/main/tmpCleanup.test.ts) 12/12 全绿,覆盖前缀白名单 / mtime 阈值 / dryRun spy / ENOENT / 越界 / liveSession。
- [ ] 手工:`ls $TMPDIR | grep giftk-` 启动 App 后 5s 重查,mtime > 24h 的目录归零。
- [ ] CLI:`npm run clean:tmp` 默认只列计划(不删);`npm run clean:tmp:apply` 才真删。
- [ ] 把 `os.tmpdir()` 改成 `/`(在测试里 mock)→ `sweepTmpDir` 立刻抛 jail 错,不发起 readdir。
