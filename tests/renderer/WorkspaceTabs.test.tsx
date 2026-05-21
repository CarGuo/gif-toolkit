/**
 * Tests for the WorkspaceTabs presentational component
 * (src/renderer/components/WorkspaceTabs.tsx).
 *
 * The component is intentionally dumb — it doesn't own state and
 * doesn't open the close-confirm dialog. So we only exercise:
 *   • renders one chip per workspace with the correct label
 *   • the active workspace gets the `.active` class so CSS can style it
 *   • clicking a non-active chip calls onSwitch with that id
 *   • clicking a non-active chip's body does NOT trigger onSwitch when
 *     it is already active (idempotent)
 *   • × button calls onClose without bubbling onSwitch
 *   • × button is hidden when only one workspace exists (so users can't
 *     orphan themselves into zero tabs from the UI)
 *   • + button calls onNewTab
 *   • busy workspaces show the busy dot
 *   • middle-click closes a tab
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceTabs } from '../../src/renderer/components/WorkspaceTabs';
import type { Workspace } from '../../src/renderer/components/useWorkspaces';
import { DEFAULT_OPTIONS } from '../../src/shared/types';

const makeWs = (overrides: Partial<Workspace>): Workspace => ({
  id: 'ws-1',
  historyId: null,
  url: '',
  result: null,
  sniffing: false,
  selected: new Set(),
  options: { ...DEFAULT_OPTIONS },
  progress: {},
  processingOne: new Set(),
  previewOverrides: {},
  resolvedMap: {},
  resolvingSet: new Set(),
  resolveErrorMap: {},
  logs: [],
  createdAt: 0,
  ...overrides
});

const noBusy = (_w: Workspace): boolean => false;

describe('WorkspaceTabs', () => {
  it('renders one tab per workspace and applies the active class', () => {
    const wss = [
      makeWs({ id: 'a', url: 'https://a.test' }),
      makeWs({ id: 'b', url: 'https://b.test' })
    ];
    const { container } = render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="b"
        isBusy={noBusy}
        onSwitch={() => undefined}
        onClose={() => undefined}
        onNewTab={() => undefined}
      />
    );
    const tabs = container.querySelectorAll('.ws-tab');
    expect(tabs.length).toBe(2);
    expect(tabs[0].className).not.toMatch(/\bactive\b/);
    expect(tabs[1].className).toMatch(/\bactive\b/);
  });

  it('clicking a non-active tab body fires onSwitch', () => {
    const onSwitch = vi.fn();
    const wss = [
      makeWs({ id: 'a', url: 'https://a.test' }),
      makeWs({ id: 'b', url: 'https://b.test' })
    ];
    const { container } = render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="a"
        isBusy={noBusy}
        onSwitch={onSwitch}
        onClose={() => undefined}
        onNewTab={() => undefined}
      />
    );
    const bTab = container.querySelectorAll('.ws-tab')[1] as HTMLElement;
    fireEvent.click(bTab);
    expect(onSwitch).toHaveBeenCalledWith('b');
  });

  it('clicking the active tab does NOT fire onSwitch', () => {
    const onSwitch = vi.fn();
    const wss = [makeWs({ id: 'a', url: 'a' }), makeWs({ id: 'b', url: 'b' })];
    const { container } = render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="a"
        isBusy={noBusy}
        onSwitch={onSwitch}
        onClose={() => undefined}
        onNewTab={() => undefined}
      />
    );
    fireEvent.click(container.querySelectorAll('.ws-tab')[0]!);
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('× button fires onClose without bubbling to onSwitch', () => {
    const onSwitch = vi.fn();
    const onClose = vi.fn();
    const wss = [makeWs({ id: 'a' }), makeWs({ id: 'b' })];
    render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="a"
        isBusy={noBusy}
        onSwitch={onSwitch}
        onClose={onClose}
        onNewTab={() => undefined}
      />
    );
    // There are two close buttons; click the second tab's.
    const closeButtons = screen.getAllByRole('button', { name: '关闭工作区' });
    expect(closeButtons.length).toBe(2);
    fireEvent.click(closeButtons[1]);
    expect(onClose).toHaveBeenCalledWith('b');
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('× is hidden when only one workspace exists (no orphaning)', () => {
    const wss = [makeWs({ id: 'a' })];
    render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="a"
        isBusy={noBusy}
        onSwitch={() => undefined}
        onClose={() => undefined}
        onNewTab={() => undefined}
      />
    );
    expect(screen.queryByRole('button', { name: '关闭工作区' })).toBeNull();
  });

  it('+ button fires onNewTab', () => {
    const onNewTab = vi.fn();
    render(
      <WorkspaceTabs
        workspaces={[makeWs({ id: 'a' })]}
        activeId="a"
        isBusy={noBusy}
        onSwitch={() => undefined}
        onClose={() => undefined}
        onNewTab={onNewTab}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '新建工作区' }));
    expect(onNewTab).toHaveBeenCalled();
  });

  it('busy workspaces show the pulsing dot', () => {
    const wss = [makeWs({ id: 'a' }), makeWs({ id: 'b' })];
    const isBusy = (w: Workspace): boolean => w.id === 'b';
    const { container } = render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="a"
        isBusy={isBusy}
        onSwitch={() => undefined}
        onClose={() => undefined}
        onNewTab={() => undefined}
      />
    );
    const tabs = container.querySelectorAll('.ws-tab');
    expect(tabs[0].querySelector('.ws-tab-busy-dot')).toBeNull();
    expect(tabs[1].querySelector('.ws-tab-busy-dot')).not.toBeNull();
  });

  it('middle-click closes a tab', () => {
    const onClose = vi.fn();
    const wss = [makeWs({ id: 'a' }), makeWs({ id: 'b' })];
    const { container } = render(
      <WorkspaceTabs
        workspaces={wss}
        activeId="a"
        isBusy={noBusy}
        onSwitch={() => undefined}
        onClose={onClose}
        onNewTab={() => undefined}
      />
    );
    const bTab = container.querySelectorAll('.ws-tab')[1] as HTMLElement;
    // happy-dom doesn't expose fireEvent.auxClick, so dispatch a raw
    // MouseEvent. The component listens for onAuxClick which fires for
    // any non-primary button via the native auxclick event.
    bTab.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    expect(onClose).toHaveBeenCalledWith('b');
  });
});
