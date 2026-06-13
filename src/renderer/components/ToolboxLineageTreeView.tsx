/**
 * R-LINEAGE-TREE-V1 — ToolboxLineageTreeView.
 *
 * Why a self-written SVG layout (no d3-hierarchy)
 * -----------------------------------------------
 * The lineage view only needs a small, deterministic horizontal tree
 * (typically <30 nodes per chain). Pulling in `d3-hierarchy` (and its
 * transitive d3-* graph) would add ~30+ KiB to the renderer bundle and
 * an external supply-chain surface (R-15) for what is, in practice, a
 * 40-line recursive DFS layout. The implementation below mirrors the
 * classic "Reingold-Tilford-lite" idea, rotated 90° so depth grows
 * left→right (X axis) and siblings stack top→bottom (Y axis). Each
 * subtree owns a vertical "height band"; a parent centers itself
 * vertically between the topmost-root and bottommost-root of its
 * children. Stable child order is enforced via `createdAt asc` so
 * re-renders never reshuffle the canvas.
 *
 * Why horizontal (R-LINEAGE-TREE-V1.1)
 * ------------------------------------
 * Vertical layout pushed every step further down the modal, eating
 * vertical real-estate the user needs for the input form on the
 * right. A horizontal tree fans branches out sideways so the typical
 * 3–6 step chain stays in a single fold, with deeper branches simply
 * scrolling right rather than vertically pushing the breadcrumb /
 * step controls below the fold.
 *
 * Node visual contract
 * --------------------
 *   - rect 140×64, rx=8
 *   - status → fill color:
 *       done    → #e8f4ff  (focus → #2563eb stroke 2px)
 *       pending → #fef3c7
 *       failed  → #fee2e2
 *       aborted → #f3f4f6
 *   - line 1 (y=20, fontWeight 600, 12px): KIND_LABELS[kind] ?? kind ?? '原始输入'
 *   - line 2 (y=40, 11px, #666): formatBytes(sizeAfter) [+ ' ⚠️' tspan when sizeRegressionRatio > 1.05]
 *                                                       [+ ' 自动回退' amber tspan when sizeRegressionReverted, takes priority over ⚠️]
 *   - line 3 (y=58, 10px, #888): localized status word (完成/处理中/失败/已中止)
 *
 * E2E data-testid contract
 * ------------------------
 *   - container        : `tb-lineage-tree-view`
 *   - per-node group   : `tb-lineage-tree-node-{nodeId}`     (g element)
 *   - regression badge : `tb-lineage-tree-warn-{nodeId}`     (tspan inside line 2)
 *   - reverted badge   : `tb-lineage-tree-reverted-{nodeId}` (amber tspan inside line 2, R-SIZE-REGRESSION-REVERT-V1)
 *   - each node g also exposes:
 *       data-status = 'pending' | 'done' | 'failed' | 'aborted'
 *       data-focus  = '1' when focusNodeId === nodeId else '0'
 *
 * Edges
 * -----
 * Per-child cubic Bezier from parent's right-center to child's
 * left-center, stroke #888, strokeWidth 1.5, fill none.
 */
import { useCallback, useMemo } from 'react';
import type { ToolboxKind } from '../../shared/types';
import type { LineageTreeNode } from './useToolboxLineage';
import { formatBytes } from './formatBytes';

// P3-B-3 — `LineageTreeNode` is now sourced from `useToolboxLineage`,
// which re-exports it from `useToolboxLineageHelpers`. The hook's
// shape is a structural superset (it also carries the renderer-only
// `ipcChainId`), so this view trivially accepts whatever the hook
// returns without further mapping.

export interface ToolboxLineageTreeViewProps {
  nodes: readonly LineageTreeNode[];
  focusNodeId: string | null;
  onSelect: (nodeId: string) => void;
}

// Inlined copy of ToolboxLineageModal's KIND_LABELS — that file does
// NOT export it, and per the spec we must not edit ToolboxLineageModal
// in this task (P3-B-3 will). Keep in lockstep manually.
const KIND_LABELS: Record<ToolboxKind, string> = {
  'video-to-gif': 'Video → GIF',
  'video-to-webp': 'Video → WebP',
  'gif-resize': 'GIF Resize',
  'gif-optimize': 'GIF Optimize',
  trim: 'Trim',
  speed: 'Speed',
  reverse: 'Reverse',
  rotate: 'Rotate',
  crop: 'Crop',
  'gif-webp-convert': 'GIF ↔ WebP'
};

const STATUS_LABELS: Record<LineageTreeNode['status'], string> = {
  done: '完成',
  pending: '处理中',
  failed: '失败',
  aborted: '已中止'
};

const STATUS_FILLS: Record<LineageTreeNode['status'], string> = {
  done: '#e8f4ff',
  pending: '#fef3c7',
  failed: '#fee2e2',
  aborted: '#f3f4f6'
};

const NODE_W = 140;
const NODE_H = 64;
// Sibling subtrees stack along the Y axis; STAGGER_GAP separates
// adjacent subtrees vertically.
const STAGGER_GAP = 24;
// Each level grows along the X axis; LEVEL_GAP is the horizontal
// distance between a parent's right edge and the child's left edge.
const LEVEL_GAP = 60;
const PADDING = 16;
const REGRESSION_THRESHOLD = 1.05;

interface Point { x: number; y: number; }
interface SubtreeLayout {
  /** Vertical height occupied by the subtree (across siblings). */
  height: number;
  positions: Map<string, Point>;
}

/**
 * Recursive DFS layout (rotated 90° from the classic top-down form):
 *   - depth → x = depth * (NODE_W + LEVEL_GAP)
 *   - siblings stack along y, each subtree owning a contiguous band
 *   - a parent centers its y between its first and last child's y
 */
function layoutSubtree(
  nodeId: string,
  depth: number,
  childrenMap: Map<string | null, LineageTreeNode[]>
): SubtreeLayout {
  const x = depth * (NODE_W + LEVEL_GAP);
  const children = childrenMap.get(nodeId) ?? [];
  if (children.length === 0) {
    const positions = new Map<string, Point>();
    positions.set(nodeId, { x, y: 0 });
    return { height: NODE_H, positions };
  }

  // 1. Recursively lay out each child subtree.
  const childLayouts: SubtreeLayout[] = children.map((c) =>
    layoutSubtree(c.nodeId, depth + 1, childrenMap)
  );

  // 2. Stitch children vertically with STAGGER_GAP between subtrees.
  const positions = new Map<string, Point>();
  let cursor = 0;
  const childRootYs: number[] = [];
  childLayouts.forEach((cl, idx) => {
    const child = children[idx];
    const offset = cursor;
    for (const [id, pt] of cl.positions) {
      positions.set(id, { x: pt.x, y: pt.y + offset });
    }
    const childRootPt = cl.positions.get(child.nodeId);
    // Defensive — childRootPt is guaranteed by the leaf base case.
    childRootYs.push((childRootPt?.y ?? 0) + offset);
    cursor += cl.height + STAGGER_GAP;
  });
  const childrenSpan = cursor - STAGGER_GAP; // remove trailing gap

  // 3. Center self vertically over first/last child root y-coordinates.
  const topMostY = childRootYs[0];
  const bottomMostY = childRootYs[childRootYs.length - 1];
  const selfY = (topMostY + bottomMostY) / 2;
  positions.set(nodeId, { x, y: selfY });

  const height = Math.max(NODE_H, childrenSpan);
  return { height, positions };
}

/** Find max depth recursively to compute SVG width. */
function computeMaxDepth(
  nodeId: string,
  depth: number,
  childrenMap: Map<string | null, LineageTreeNode[]>
): number {
  const children = childrenMap.get(nodeId) ?? [];
  if (children.length === 0) return depth;
  let max = depth;
  for (const c of children) {
    const d = computeMaxDepth(c.nodeId, depth + 1, childrenMap);
    if (d > max) max = d;
  }
  return max;
}

export function ToolboxLineageTreeView(props: ToolboxLineageTreeViewProps): JSX.Element {
  const { nodes, focusNodeId, onSelect } = props;

  const layout = useMemo(() => {
    // Build children map keyed by parentNodeId, child arrays sorted by
    // createdAt ascending for stable layout across re-renders.
    const childrenMap = new Map<string | null, LineageTreeNode[]>();
    for (const n of nodes) {
      const arr = childrenMap.get(n.parentNodeId) ?? [];
      arr.push(n);
      childrenMap.set(n.parentNodeId, arr);
    }
    for (const arr of childrenMap.values()) {
      arr.sort((a, b) => a.createdAt - b.createdAt);
    }

    const roots = childrenMap.get(null) ?? [];
    if (roots.length === 0) {
      return {
        positions: new Map<string, Point>(),
        viewBoxW: NODE_W + PADDING * 2,
        viewBoxH: NODE_H + PADDING * 2
      };
    }

    // Stitch root subtrees vertically with the same STAGGER_GAP rule.
    const positions = new Map<string, Point>();
    let cursor = 0;
    let maxDepth = 0;
    for (const r of roots) {
      const sub = layoutSubtree(r.nodeId, 0, childrenMap);
      for (const [id, pt] of sub.positions) {
        positions.set(id, { x: pt.x, y: pt.y + cursor });
      }
      const d = computeMaxDepth(r.nodeId, 0, childrenMap);
      if (d > maxDepth) maxDepth = d;
      cursor += sub.height + STAGGER_GAP;
    }
    const totalHeight = cursor - STAGGER_GAP;

    // Add PADDING and shift positions so node bounds (not just root)
    // sit inside the viewBox. Node rects extend NODE_W to the right
    // and NODE_H downward.
    for (const [id, pt] of positions) {
      positions.set(id, { x: pt.x + PADDING, y: pt.y + PADDING });
    }
    const viewBoxW = maxDepth * (NODE_W + LEVEL_GAP) + NODE_W + PADDING * 2;
    const viewBoxH = totalHeight + PADDING * 2;
    return { positions, viewBoxW, viewBoxH };
  }, [nodes]);

  const handleSelect = useCallback(
    (nodeId: string) => {
      onSelect(nodeId);
    },
    [onSelect]
  );

  // Build edges from child → parent using positions. Horizontal cubic
  // Bezier: parent right-center → child left-center, control points
  // pushed half a level apart on the X axis to give the curve breath.
  const edges = useMemo(() => {
    const list: Array<{ key: string; d: string }> = [];
    for (const n of nodes) {
      if (!n.parentNodeId) continue;
      const cp = layout.positions.get(n.nodeId);
      const pp = layout.positions.get(n.parentNodeId);
      if (!cp || !pp) continue;
      const px = pp.x + NODE_W;
      const py = pp.y + NODE_H / 2;
      const cx = cp.x;
      const cy = cp.y + NODE_H / 2;
      const c1x = px + LEVEL_GAP / 2;
      const c2x = cx - LEVEL_GAP / 2;
      const d = `M ${px} ${py} C ${c1x} ${py}, ${c2x} ${cy}, ${cx} ${cy}`;
      list.push({ key: `${n.parentNodeId}->${n.nodeId}`, d });
    }
    return list;
  }, [nodes, layout]);

  return (
    <div className="tb-lineage-tree-view" data-testid="tb-lineage-tree-view">
      <svg
        viewBox={`0 0 ${layout.viewBoxW} ${layout.viewBoxH}`}
        preserveAspectRatio="xMinYMin meet"
        width={layout.viewBoxW}
        height={layout.viewBoxH}
      >
        <g className="tb-lineage-tree-edges">
          {edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              stroke="#888"
              fill="none"
              strokeWidth={1.5}
            />
          ))}
        </g>
        <g className="tb-lineage-tree-nodes">
          {nodes.map((n) => {
            const pt = layout.positions.get(n.nodeId);
            if (!pt) return null;
            const isFocus = focusNodeId === n.nodeId;
            const fill = STATUS_FILLS[n.status];
            const stroke = isFocus && n.status === 'done' ? '#2563eb' : '#cfd6df';
            const strokeWidth = isFocus && n.status === 'done' ? 2 : 1;
            const kindLabel = n.kind ? (KIND_LABELS[n.kind] ?? n.kind) : '原始输入';
            const sizeText =
              typeof n.sizeAfter === 'number' ? formatBytes(n.sizeAfter) : '';
            const isReverted = n.sizeRegressionReverted === true;
            const isRegression =
              !isReverted &&
              typeof n.sizeRegressionRatio === 'number' &&
              n.sizeRegressionRatio > REGRESSION_THRESHOLD;
            return (
              <g
                key={n.nodeId}
                transform={`translate(${pt.x},${pt.y})`}
                onClick={() => handleSelect(n.nodeId)}
                data-testid={`tb-lineage-tree-node-${n.nodeId}`}
                data-status={n.status}
                data-focus={isFocus ? '1' : '0'}
                cursor="pointer"
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={8}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                />
                <text x={10} y={20} fontSize={12} fontWeight={600}>
                  {kindLabel}
                </text>
                <text x={10} y={40} fontSize={11} fill="#666">
                  {sizeText}
                  {isReverted ? (
                    <tspan
                      data-testid={`tb-lineage-tree-reverted-${n.nodeId}`}
                      fill="#b45309"
                      fontWeight={600}
                    >
                      <title>这一步未能减小体积,已自动复制原图作为输出</title>
                      {' 自动回退'}
                    </tspan>
                  ) : isRegression ? (
                    <tspan
                      data-testid={`tb-lineage-tree-warn-${n.nodeId}`}
                    >
                      {' ⚠️'}
                    </tspan>
                  ) : null}
                </text>
                <text x={10} y={58} fontSize={10} fill="#888">
                  {STATUS_LABELS[n.status]}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

export default ToolboxLineageTreeView;
