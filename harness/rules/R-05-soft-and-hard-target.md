# R-05 — soft 2MB / hard 4MB 双层目标

## 规则
- `softMaxBytes` 默认 2 097 152(2MB),代表"最佳目标"
- `maxBytes` 默认 4 194 304(4MB),代表"降级上限"
- 两者满足 `softMaxBytes ≤ maxBytes`,UI 上互相 clamp

## 为什么
- 用户明确(第 17 轮):"最佳目标 2M 以内,降级目标 4M"
- 没有分级 → 一刀切要么 4MB(质量过牺牲) 要么 2MB(失败率太高)

## 怎么遵守
- 改 [DEFAULT_OPTIONS](file:///Users/guoshuyu/workspace/gif-toolkit/src/shared/types.ts) 时同时改 [OptionsForm.tsx](file:///Users/guoshuyu/workspace/gif-toolkit/src/renderer/components/OptionsForm.tsx) 的输入控件
- [sanitizeOptions](file:///Users/guoshuyu/workspace/gif-toolkit/src/main/index.ts) 必须 clamp:`soft = min(soft, hard)`、`hard = max(soft, hard)`

## 反例
- ❌ UI 允许 soft > hard
- ❌ Phase D 命中 fallback 后还把日志标 `(best)`

## 关联场景
- [SC-03](file:///Users/guoshuyu/workspace/gif-toolkit/harness/scenarios/SC-03-soft-vs-hard-target.md)
