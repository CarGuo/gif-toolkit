# New Feature Checklist — 新增功能前先回答这 12 个问题

> 在你动手写代码之前,先回答下面 12 个问题。**有任何一题答不上来,就先回答清楚再开工**。
> 这套问题是从历史 SC-01..SC-06 复盘里反向提炼出来的"前置思考清单"。

---

## 1. 范围
- [ ] 这个功能修改/新增了哪些文件?(尽量列全)
- [ ] 它会跨主/渲两个进程吗?如果跨,IPC 通道叫什么?

## 2. 类型边界
- [ ] 它是否需要在 [src/shared/types.ts](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) 加新类型?
- [ ] 它是否会破坏现有 [SniffedMedia](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) / [ProcessOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) / [TaskProgress](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) 的字段?

## 3. 嗅探层
- [ ] 是否新加嗅探规则?它的 `source` 取什么值?优先级排在哪条之前?
- [ ] 它是否需要扩 [matchEmbedProvider](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L51-L78) 的白名单?

## 4. 压缩层
- [ ] 它是否会触碰 Phase A/B/C/D 中任何一段?
- [ ] 是否依然保证 longSideFloor 守护?(R-06)
- [ ] 是否依然保证 soft ≤ hard 的双层目标?(R-05)

## 5. 进度 / 并发
- [ ] 新流程要 emit 几次 TaskProgress?每次带哪些字段?(R-08)
- [ ] 它是否会用到 PQueue?会不会改 concurrency 行为?(R-07)

## 6. UI
- [ ] 是否新增 React 组件?它在哪个父组件里?
- [ ] 是否依然适配窗口缩放?

## 7. 安全
- [ ] 它是否要读本地路径?如果是,通过哪个 IPC?(不能在 Renderer 直接读)
- [ ] 它是否要执行 child_process?(只能在 Main)

## 8. 打包
- [ ] 是否引入了带 native 二进制的依赖?要不要更新 [package.json asarUnpack](file:///Users/guoshuyu/workspace/gif-toolkit/package.json#L61-L68)?

## 9. 错误恢复
- [ ] 失败模式有哪些?有没有早 fail 的机会?(参考 SC-02)
- [ ] 失败时给用户的信息是中英文混合 + 关键数字吗?

## 10. 回归场景
- [ ] 这次改动会不会让任何已有 SC 失效?
- [ ] 我是否计划在做完之后,新增一个 SC-XX 来"锁住"这次的功能?

## 11. 文档
- [ ] [docs/](file:///Users/guoshuyu/workspace/gif-toolkit/docs/) 中哪个文件需要同步?
- [ ] [README.md](file:///Users/guoshuyu/workspace/gif-toolkit/README.md) 是否需要更新?

## 12. 复演
- [ ] 我能在 30 秒内说清"功能上线后,我用什么输入、看什么输出来确认它工作"?
- [ ] 我有没有 fixture(URL / mhtml / 本地文件)能放进 [harness/regression/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/regression/)?

## 13. 测试(R-16)
- [ ] 这个功能里的纯函数 / 组件 / IPC handler **必须**配套 `tests/**/*.test.{ts,tsx}` 用例,我已经规划好了在哪个文件加哪些断言
- [ ] 边界条件(空输入 / 上限 / 失败路径)都有用例覆盖
- [ ] 如果是修 bug:我会**先**写一个会因 bug 失败的回归测试,再改代码
- [ ] `npm test` 必须 0 失败、不允许 `*.skip`

---

## 答完这些之后

- 用 [TodoWrite](file:///) 写出步骤计划
- 按 [SOP](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md#3-标准操作流程sop-for-agents) 执行
- 提交前对照 [pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md)
