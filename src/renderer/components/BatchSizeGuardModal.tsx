import React, { useMemo, useState } from 'react';
import type { SniffedMedia } from '../../shared/types';

/**
 * R-72 — Pre-flight aspect-ratio modal for batch dispatch.
 *
 * Before this modal existed, every task that the processor's
 * AspectRatioConstraintError check rejected (longest > maxSide AND
 * short side after cap < minSide) showed up in the task table with a
 * single "强制允许" button. For a batch with ten such tasks the user
 * had to click ten times to override them all — exactly what the
 * R-71 → R-72 user feedback called out.
 *
 * This modal:
 *   1. Lists every batch entry that WOULD fail the spec check given
 *      the current options + sniffed dims (computed by the renderer
 *      via shared/sizeGuard.evaluateSizeGuard, so the modal stays a
 *      dumb presentation component).
 *   2. Defaults each row to "checked" (the user almost always wants
 *      to allow them all — the alternative is dropping those items).
 *   3. Shows a master "全部强制允许" toggle for one-click flip / unflip.
 *   4. Has three exits:
 *        - "确认" → hand back the set of media ids that get
 *          forceAllowSmallSide=true on this dispatch only. App.tsx
 *          merges this set into the per-task ProcessOptions; the
 *          flag is NOT sticky on global options.
 *        - "全部跳过" → return an empty set; the at-risk tasks will
 *          be removed from the dispatch list by App.tsx so the
 *          user gets a clean batch of compliant items only.
 *        - "取消" → close the modal, do nothing.
 *
 * Note we INTENTIONALLY do not let the user change maxWidth / minSize
 * here. Adjusting those globally during dispatch would either (a)
 * silently override their stored preference for future batches or
 * (b) require a parallel "save / discard" UX. Both are out of scope
 * for R-72 — that knob already lives in OptionsForm and the
 * modal's whole job is to deal with the per-batch override, not to
 * reconfigure defaults.
 */
export interface BatchSizeGuardEntry {
  media: SniffedMedia;
  origW: number;
  origH: number;
  maxSide: number;
  minSide: number;
  shortSideAtMax: number;
}

interface Props {
  entries: BatchSizeGuardEntry[];
  /** Render-only: what the user originally selected. We pass it
   *  through so the result modal can label "X 个任务已自动调整" with
   *  a denominator. */
  totalTasks: number;
  /**
   * User picked "确认" — `forceAllowIds` is the subset of entry
   * media ids that should run with forceAllowSmallSide=true. Tasks
   * whose id is NOT in this set will be DROPPED from the dispatch
   * (the user explicitly opted not to force-allow them).
   */
  onConfirm: (forceAllowIds: Set<string>) => void;
  onCancel: () => void;
}

export const BatchSizeGuardModal: React.FC<Props> = ({
  entries,
  totalTasks,
  onConfirm,
  onCancel
}) => {
  // Initial selection: all rows checked. The vast majority of users
  // hitting this modal want "yes, run them all anyway" — making them
  // un-tick to opt out of an item is exactly the "fewer clicks"
  // outcome R-72 is for.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const init = new Set<string>();
    for (const e of entries) init.add(e.media.id);
    return init;
  });

  const allChecked = selected.size === entries.length && entries.length > 0;
  const noneChecked = selected.size === 0;

  // Master toggle: flip all on/off. We don't expose a tristate visual
  // because the partial state is already implicit in row checkboxes.
  const toggleAll = () => {
    if (allChecked) {
      setSelected(new Set());
    } else {
      const next = new Set<string>();
      for (const e of entries) next.add(e.media.id);
      setSelected(next);
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Stable summary string used in both the heading and the confirm
  // button label. Memoized only because react-strict-mode double-invokes
  // and this happens to be the cheapest way to keep both labels in sync.
  const summary = useMemo(() => {
    return `本批共 ${totalTasks} 个任务,其中 ${entries.length} 个会因「最长边封顶后短边过小」被拒;` +
      `已勾 ${selected.size} 个将以「强制允许」继续,未勾的会从本次批处理中跳过`;
  }, [entries.length, selected.size, totalTasks]);

  return (
    <div
      role="dialog"
      aria-label="batch-size-guard-modal"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: 'var(--surface, #1f2228)',
          color: 'var(--text, #eee)',
          padding: 18,
          borderRadius: 8,
          maxWidth: 720,
          width: '90%',
          maxHeight: '80vh',
          overflowY: 'auto',
          boxShadow: '0 10px 30px rgba(0,0,0,0.4)'
        }}
      >
        <h3 style={{ marginTop: 0, fontSize: 15 }}>
          有任务尺寸不符 · 是否一键强制允许?(R-72)
        </h3>
        <div style={{ color: 'var(--muted, #aaa)', fontSize: 12, marginBottom: 12 }}>
          {summary}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            border: '1px solid var(--border, #2a2d33)',
            borderRadius: 6,
            marginBottom: 10,
            background: 'var(--surface-alt, #2a2d33)'
          }}
        >
          <input
            id="size-guard-toggle-all"
            type="checkbox"
            checked={allChecked}
            // partial-checked → render as unchecked but indeterminate visual
            // for screen readers; native checkbox supports it via property.
            ref={(el) => {
              if (el) el.indeterminate = !allChecked && !noneChecked;
            }}
            onChange={toggleAll}
            aria-label="全部强制允许"
          />
          <label
            htmlFor="size-guard-toggle-all"
            style={{ fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
          >
            全部强制允许({entries.length} 项)
          </label>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((e) => {
            const checked = selected.has(e.media.id);
            const title = e.media.url;
            const short = title.length > 70 ? title.slice(0, 67) + '…' : title;
            return (
              <label
                key={e.media.id}
                style={{
                  border: '1px solid var(--border, #2a2d33)',
                  borderRadius: 6,
                  padding: 10,
                  display: 'flex',
                  gap: 10,
                  alignItems: 'flex-start',
                  cursor: 'pointer',
                  background: checked ? 'var(--surface-hover, #262a31)' : 'transparent'
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleOne(e.media.id)}
                  aria-label={`force-allow-${e.media.id}`}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <b>{e.media.kind.toUpperCase()}</b>
                    <span style={{ color: 'var(--muted)', marginLeft: 6 }}>
                      {e.origW}×{e.origH} → 封顶 {e.maxSide}px 后短边只剩 {e.shortSideAtMax}px
                      ( &lt; 最小 {e.minSide}px )
                    </span>
                  </div>
                  <div
                    style={{
                      color: 'var(--muted)',
                      fontSize: 11,
                      wordBreak: 'break-all'
                    }}
                  >
                    {short}
                  </div>
                </div>
              </label>
            );
          })}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
            marginTop: 16
          }}
        >
          <button type="button" onClick={onCancel}>取消</button>
          <button
            type="button"
            onClick={() => onConfirm(new Set())}
            title="把这些任务从本次批处理中移除,只跑没有尺寸问题的项"
          >
            全部跳过
          </button>
          <button
            type="button"
            onClick={() => onConfirm(new Set(selected))}
            style={{ fontWeight: 600 }}
          >
            {selected.size === entries.length
              ? `强制允许全部并继续(${entries.length})`
              : `继续(强制 ${selected.size} · 跳过 ${entries.length - selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
};
