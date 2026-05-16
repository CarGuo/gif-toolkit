# harness/regression/

> 回归测试用的 fixtures。
>
> **当前阶段**:仅记录"输入 + 期望产物"的元数据(JSON),不放二进制。等接入 vitest 之后,这里会放 .gif/.mp4/.mhtml 的 sample(可能用 git-lfs)。

## 目录结构

```
regression/
├── README.md       ← 你正在看的
└── fixtures.json   ← 每条:URL / 类型 / 期望嗅探结果数 / 期望产物字节数上限
```

## 当前 fixtures.json 字段说明

| 字段 | 含义 |
|---|---|
| `id` | SC-XX 对应编号 |
| `kind` | `'sniff'` / `'compress'` / `'flow'` |
| `input` | 输入(URL / 本地文件) |
| `expected.snifferCount` | 期望嗅探结果条数 |
| `expected.itemsContaining` | 期望出现的 URL 子串(数组) |
| `expected.outputMaxBytes` | 期望产物体积上限(字节) |
| `expected.outputTier` | `'best'` / `'fallback'` / `'skipped'` |

## 怎么加新 fixture
1. 用最小可复演的输入(public URL / 本地构造)
2. 不要把含版权的视频放进 fixture
3. 不要把超过 5MB 的二进制塞 git
4. 加完后在对应 SC-XX 文档里引用 fixture id
