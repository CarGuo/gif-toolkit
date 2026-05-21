# R-02 — 不为某个 host 加白名单

## 规则
**任何嗅探规则必须是结构化的**,不能写成 "如果 host 是 X.com 就特殊处理"。

## 为什么

- 用户明确说过(第 14/15 轮):"我要的是通用实现,不是针对某个 url 进行特定化处理"
- 单个 host 的 hack 会越积越多,变成不可维护的 if 阶梯

## 怎么遵守
- 新加规则用"特征 + 路径模式"双重判定
- 如果你确实需要识别某类 player(如 Vimeo),用 [matchEmbedProvider](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/sniffer.ts#L51-L78) 那张**结构化白名单**(hostSuffix + needsPath),不要单独写 if

## 反例
- No `if (host === 'blogger.googleusercontent.com') applyDedup()`
- No `if (url.includes('twimg.com')) skipQueryStripping()`

## 反向例(可接受的"结构化"白名单)
- Yes `RULES = [{ hostSuffix: 'player.vimeo.com', needsPath: '/video/', provider: 'vimeo.com' }, ...]`
- Yes 通用化后的 dedupKey 把"展示型 query 参数"按特征剥离

## 关联场景
- [SC-01](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-01-dedup-key-generic.md)
- [SC-04](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-04-iframe-embed-vimeo.md)
