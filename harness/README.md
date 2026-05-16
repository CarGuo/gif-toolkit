# harness/ — Gif Toolkit 工程级 Harness

> **Harness Engineering 的核心理念**:每当发现 Agent / 协作者犯错,就构建一套工程化方案,确保未来不会再犯同样的错误。
>
> 这一目录是这个理念在 Gif Toolkit 仓库里的具体实现。它不是单元测试,也不是文档——它是**让规则与回归场景**这两件事在工程里并列存在,可迭代、可回归、可被任何新协作者快速 onboard。

---

## 目录组织

```
harness/
├── README.md             ← 你正在看的(这套 harness 怎么读 / 怎么用)
├── run-harness.md        ← 怎么跑一遍(本地手动 + 半自动)
├── rules/                ← R-01..R-12 每条一个 markdown
│   ├── R-01-sniff-must-go-through-main.md
│   ├── R-02-no-host-whitelist.md
│   ├── R-03-maxside-applies-to-both-axes.md
│   ├── R-04-four-phase-compression.md
│   ├── R-05-soft-and-hard-target.md
│   ├── R-06-shortside-floor.md
│   ├── R-07-pqueue-concurrency.md
│   ├── R-08-progress-richness.md
│   ├── R-09-iframe-embed-detect-only.md
│   ├── R-10-electron-isolation.md
│   ├── R-11-preload-whitelist.md
│   └── R-12-do-not-evade-tests.md
├── scenarios/            ← SC-01..SC-N 历史问题对应的回归场景
│   ├── SC-01-dedup-key-generic.md
│   ├── SC-02-aspect-ratio-early-fail.md
│   ├── SC-03-soft-vs-hard-target.md
│   ├── SC-04-iframe-embed-vimeo.md
│   ├── SC-05-progress-richness.md
│   └── SC-06-concurrency-default-3.md
├── checklists/
│   ├── pr-checklist.md             ← 提交 PR 前自检
│   └── new-feature-checklist.md    ← 新增功能前要回答的 12 个问题
└── regression/                     ← 测试 fixture(URL / 期望产物)
    ├── README.md
    └── fixtures.json
```

---

## 三种文件,三件事

| 类型 | 关注点 | 命名 | 何时新增 |
|---|---|---|---|
| **rules/** | "**永远**应该做到的事" | `R-XX-<slogan>.md` | 当一个原则被多次踩坑后升格为硬规则 |
| **scenarios/** | "**这个具体场景**下应该如何表现" | `SC-XX-<slug>.md` | 每发现一个新 bug,都对应建一个 |
| **checklists/** | "改前/提交前必勾的清单" | — | 流程改动 |

> 灵感来源:["Harness Engineering" 的六层结构](https://zhuanlan.zhihu.com/p/2014799697290753718) — 角色定义 / 工具设计 / 上下文管理 / 反馈循环 / 错误恢复 / 评估 Trace。本仓库把它收敛为这三种文件 + AGENTS.md 顶层规约。

---

## 怎么用?(三种角色三种用法)

### 我是新来的协作者

1. 先读 [AGENTS.md](file:///Users/guoshuyu/workspace/gif-toolkit/AGENTS.md) — 12 条硬规则
2. 浏览 [scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) — 看历史踩过的坑
3. 改前对照 [checklists/new-feature-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/new-feature-checklist.md)
4. 提交前对照 [checklists/pr-checklist.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/checklists/pr-checklist.md)

### 我在做日常迭代

1. 接到需求 → 先 grep `harness/scenarios/` 关键词
2. 命中已有 SC → 直接复用规则,**不再二次发明**
3. 修完后跑 `npm run typecheck && npm run lint && npm run build`
4. 影响 R-XX 的话,把对应 SC 跑一遍(见 [run-harness.md](file:///Users/guoshuyu/workspace/gif-toolkit/harness/run-harness.md))

### 我刚修了一个新发现的 bug

**这是 Harness Engineering 真正起作用的瞬间**:

1. 在 [scenarios/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/) 新增一个 `SC-XX-<slug>.md`,用 [SC 模板](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-01-dedup-key-generic.md) 填:症状 / 根因 / 期望 / 验证步骤 / 反向断言
2. 如果发现这是反复同类的问题 → 把它升格成 [rules/](file:///Users/guoshuyu/workspace/gif-toolkit/harness/rules/) 里的一条 R-XX,并在 AGENTS.md 第 1 节加一行
3. 在 [regression/fixtures.json](file:///Users/guoshuyu/workspace/gif-toolkit/harness/regression/fixtures.json) 加一条对应 fixture(若有 URL / mhtml 可保留)

> 这是工程级 harness 的"复利":每多一个 SC,以后这类 bug 复发的代价就趋近于 0。
