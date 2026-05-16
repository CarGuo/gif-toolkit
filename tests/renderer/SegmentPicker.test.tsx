/**
 * Tests for the standalone SegmentPicker component (R-23 refactor of R-22).
 * SegmentPicker is the shared chip UI used by both the inline PreviewPanel
 * and the new BatchSegmentModal. These tests exercise it directly so each
 * caller can rely on the contract without re-testing chip mechanics.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentPicker, buildSegmentPreviews } from '../../src/renderer/components/SegmentPicker';

describe('buildSegmentPreviews', () => {
  it('returns [] when range fits in a single segment', () => {
    expect(buildSegmentPreviews(0, 10, 20)).toEqual([]);
  });

  it('splits a 50s range into 3 equal segments at cap=20', () => {
    const segs = buildSegmentPreviews(0, 50, 20);
    expect(segs.length).toBe(3);
    // ceil(50/20) = 3, each 50/3 ≈ 16.67s.
    expect(segs[0].start).toBeCloseTo(0, 5);
    expect(segs[1].start).toBeCloseTo(50 / 3, 5);
    expect(segs[2].end).toBeCloseTo(50, 5);
  });

  it('respects non-zero start by offsetting every segment', () => {
    const segs = buildSegmentPreviews(10, 70, 20); // 60s range, 3 segs
    expect(segs.length).toBe(3);
    expect(segs[0].start).toBeCloseTo(10, 5);
    expect(segs[2].end).toBeCloseTo(70, 5);
  });

  it('returns [] for empty / inverted ranges', () => {
    expect(buildSegmentPreviews(20, 10, 20)).toEqual([]);
    expect(buildSegmentPreviews(5, 5, 20)).toEqual([]);
  });
});

describe('SegmentPicker UI', () => {
  const segs = buildSegmentPreviews(0, 60, 20); // 3 segments of 20s

  it('renders nothing when segments list is empty', () => {
    const { container } = render(
      <SegmentPicker segments={[]} selectedSegments={undefined} onChange={() => undefined} />
    );
    expect(container.querySelector('.segment-picker')).toBeNull();
  });

  it('defaults to selecting only segment #0 when selectedSegments is undefined', () => {
    render(
      <SegmentPicker segments={segs} selectedSegments={undefined} onChange={() => undefined} />
    );
    const chips = screen.getAllByLabelText(/segment \d+/) as HTMLInputElement[];
    expect(chips.length).toBe(3);
    expect(chips[0].checked).toBe(true);
    expect(chips[1].checked).toBe(false);
    expect(chips[2].checked).toBe(false);
  });

  it('honours an explicit selectedSegments=[0,2] prop', () => {
    render(
      <SegmentPicker segments={segs} selectedSegments={[0, 2]} onChange={() => undefined} />
    );
    const chips = screen.getAllByLabelText(/segment \d+/) as HTMLInputElement[];
    expect(chips[0].checked).toBe(true);
    expect(chips[1].checked).toBe(false);
    expect(chips[2].checked).toBe(true);
  });

  it('"全选" button reports every index to onChange', () => {
    const onChange = vi.fn();
    render(
      <SegmentPicker segments={segs} selectedSegments={undefined} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(onChange).toHaveBeenCalledWith([0, 1, 2]);
  });

  it('"仅第 1 段" button reports [0]', () => {
    const onChange = vi.fn();
    render(
      <SegmentPicker segments={segs} selectedSegments={[0, 1, 2]} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: '仅第 1 段' }));
    expect(onChange).toHaveBeenCalledWith([0]);
  });

  it('toggling the last chip when only #0 selected reports [0,2]', () => {
    const onChange = vi.fn();
    render(
      <SegmentPicker segments={segs} selectedSegments={undefined} onChange={onChange} />
    );
    fireEvent.click(screen.getByLabelText('segment 3'));
    expect(onChange).toHaveBeenCalledWith([0, 2]);
  });

  it('toggling off the only selected chip reports undefined (not empty array)', () => {
    const onChange = vi.fn();
    render(
      <SegmentPicker segments={segs} selectedSegments={[1]} onChange={onChange} />
    );
    fireEvent.click(screen.getByLabelText('segment 2'));
    // After deselect → empty set → SegmentPicker normalises to undefined so
    // downstream code can treat "no explicit pick" identically to the
    // initial state.
    expect(onChange).toHaveBeenCalledWith(undefined);
  });
});
