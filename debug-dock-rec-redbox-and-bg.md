# Debug Session: dock-rec-redbox-and-bg

**Status:** [OPEN]
**Started:** 2026-06-18
**Owner:** Trae Agent
**User report:** 多轮"录制不准"+ 折叠球白底 + 录制产物里有红线/录到的不是选区内容

---

## Symptoms (Actual vs Expected)

- **Expected**: 用户在桌面框出一块矩形（含工具箱"最长边 720"表单），按 Enter 录 → 产物应是该矩形内动画
- **Actual (图1)**: 产物是空背景 + 主窗/dock 的一片灰带，没有期望内容
- **Actual (图3)**: 录制过程中红框 overlay 紧贴选区外侧仍可见（前一轮 setContentProtection 之后还看到？需验证）

## Hypotheses

| ID | Description | Status |
|----|-------------|--------|
| H1 | selector region 是跨 display 全局坐标，但 ffmpeg `-i N` 抓的是固定主屏 → 错位 | pending |
| H2 | detectMacScreenDevice 返回 idx ≠ 选区所在 display 真实 avfoundation idx | pending |
| H3 | region.x/y/w/h 是 logical px，未乘 scaleFactor → crop 抓到 1/4 | pending |
| H4 | dock/staticOverlay 在录制开始前一瞬遮住选区，被抓进帧 | pending |
| H5 | mac avfoundation 主屏 idx 偏移错误 (1 vs 0 兜底) | pending |

## Evidence

(待插桩后填充)

## Decision

(待证据后)

## Fix

(待证据后)
