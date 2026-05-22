/**
 * R-LINEAGE-TREE-V1 — ToolboxLineageTreeView.
 *
 * Why a self-written SVG layout (no d3-hierarchy)
 * -----------------------------------------------
 * The lineage view only needs a small, deterministic top-down tree
 * (typically <30 nodes per chain). Pulling in `d3-hierarchy` (and its
 * transitive d3-* graph) would add ~30+ KiB to the renderer bundle and
 * an external supply-chain surface (R-15) for what is, in practice, a
 * 40-line recursive DFS layout. The implementation below mirrors the
 * classic "Reingold-Tilford-lite" idea: each subtree owns a horizontal
 * width; a parent centers itself between the leftmost-root and
 * rightmost-root of its children. Stable child order is enforced via
 * `createdAt asc` so re-renders never reshuffle the canvas.
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
 *   - line 3 (y=58, 10px, #888): localized status word (完成/处理中/失败/已中止)
 *
 * E2E data-testid contract
 * ------------------------
 *   - container        : `tb-lineage-tree-view`
 *   - per-node group   : `tb-lineage-tree-node-{nodeId}`     (g element)
 *   - regression badge : `tb-lineage-tree-warn-{nodeId}`     (tspan inside line 2)
 *   - each node g also exposes:
 *       data-status = 'pending' | 'done' | 'failed' | 'aborted'
 *       data-focus  = '1' when focusNodeId === nodeId else '0'
 *
 * Edges
 * -----
 * Per-child cubic Bezier from parent's bottom-center to child's
 * top-center, stroke #888, strokeWidth 1.5, fill none.
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
const H_GAP = 24;
const V_GAP = 40;
const PADDING = 16;
const REGRESSION_THRESHOLD = 1.05;

interface Point { x: number; y: number; }
interface SubtreeLayout {
  width: number;
  positions: Map<string, Point>;
}

/** Recursive DFS layout — see file-level jsdoc for the algorithm. */
function layoutSubtree(
  nodeId: string,
  depth: number,
  childrenMap: Map<string | null, LineageTreeNode[]>
): SubtreeLayout {
  const y = depth * (NODE_H + V_GAP);
  const children = childrenMap.get(nodeId) ?? [];
  if (children.length === 0) {
    const positions = new Map<string, Point>();
    positions.set(nodeId, { x: 0, y });
    return { width: NODE_W, positions };
  }

  // 1. Recursively lay out each child subtree.
  const childLayouts: SubtreeLayout[] = children.map((c) =>
    layoutSubtree(c.nodeId, depth + 1, childrenMap)
  );

  // 2. Stitch children horizontally with H_GAP between subtrees.
  const positions = new Map<string, Point>();
  let cursor = 0;
  const childRootXs: number[] = [];
  childLayouts.forEach((cl, idx) => {
    const child = children[idx];
    const offset = cursor;
    for (const [id, pt] of cl.positions) {
      positions.set(id, { x: pt.x + offset, y: pt.y });
    }
    const childRootPt = cl.positions.get(child.nodeId);
    // Defensive — childRootPt is guaranteed by the leaf base case.
    childRootXs.push((childRootPt?.x ?? 0) + offset);
    cursor += cl.width + H_GAP;
  });
  const childrenSpan = cursor - H_GAP; // remove trailing gap

  // 3. Center self over first/last child root x-coordinates.
  const leftMostX = childRootXs[0];
  const rightMostX = childRootXs[childRootXs.length - 1];
  const selfX = (leftMostX + rightMostX) / 2;
  positions.set(nodeId, { x: selfX, y });

  const width = Math.max(NODE_W, childrenSpan);
  return { width, positions };
}

/** Find max depth recursively to compute SVG height. */
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

    // Stitch root subtrees horizontally with the same H_GAP rule.
    const positions = new Map<string, Point>();
    let cursor = 0;
    let maxDepth = 0;
    for (const r of roots) {
      const sub = layoutSubtree(r.nodeId, 0, childrenMap);
      for (const [id, pt] of sub.positions) {
        positions.set(id, { x: pt.x + cursor, y: pt.y });
      }
      const d = computeMaxDepth(r.nodeId, 0, childrenMap);
      if (d > maxDepth) maxDepth = d;
      cursor += sub.width + H_GAP;
    }
    const totalWidth = cursor - H_GAP;

    // Add PADDING and shift positions so node bounds (not just root x)
    // sit inside the viewBox. Node rects extend NODE_W to the right.
    for (const [id, pt] of positions) {
      positions.set(id, { x: pt.x + PADDING, y: pt.y + PADDING });
    }
    const viewBoxW = totalWidth + NODE_W + PADDING * 2;
    const viewBoxH = maxDepth * (NODE_H + V_GAP) + NODE_H + PADDING * 2;
    return { positions, viewBoxW, viewBoxH };
  }, [nodes]);

  const handleSelect = useCallback(
    (nodeId: string) => {
      onSelect(nodeId);
    },
    [onSelect]
  );

  // Build edges from child → parent using positions.
  const edges = useMemo(() => {
    const list: Array<{ key: string; d: string }> = [];
    for (const n of nodes) {
      if (!n.parentNodeId) continue;
      const cp = layout.positions.get(n.nodeId);
      const pp = layout.positions.get(n.parentNodeId);
      if (!cp || !pp) continue;
      const px = pp.x + NODE_W / 2;
      const py = pp.y + NODE_H;
      const cx = cp.x + NODE_W / 2;
      const cy = cp.y;
      const c1y = py + V_GAP / 2;
      const c2y = cy - V_GAP / 2;
      const d = `M ${px} ${py} C ${px} ${c1y}, ${cx} ${c2y}, ${cx} ${cy}`;
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
            const isRegression =
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
                  {isRegression ? (
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
