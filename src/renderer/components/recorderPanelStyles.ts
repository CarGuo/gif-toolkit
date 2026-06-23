/**
 * RecorderPanel styles 抽出（让 RecorderPanel.tsx 维持在 600 行 lint 上限内）。
 * 全是纯 CSSProperties 工厂，无 React state 依赖。
 */
import type React from 'react';

export const inputStyle: React.CSSProperties = {
  background: '#0e1116',
  color: '#cfd5df',
  border: '1px solid #2a2f3a',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 13,
  outline: 'none',
};

export const primaryBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: '#4fa3ff',
  color: '#0c1118',
  border: 0,
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};

export const dangerBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: '#ff4f4f',
  color: '#fff',
  border: 0,
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
};

export const ghostBtn: React.CSSProperties = {
  padding: '8px 16px',
  background: '#1f242d',
  color: '#cfd5df',
  border: '1px solid #2a2f3a',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

export function chipStyle(active: boolean): React.CSSProperties {
  return {
    minWidth: 32,
    padding: '5px 10px',
    background: active ? '#4fa3ff' : '#1f242d',
    color: active ? '#0c1118' : '#cfd5df',
    border: `1px solid ${active ? '#4fa3ff' : '#2a2f3a'}`,
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    fontVariantNumeric: 'tabular-nums',
  };
}

/** 双模式选择卡——给 mode 更高视觉权重，左卡里两个并排的"块状按钮"。 */
export function modeCardStyle(active: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 140,
    padding: '12px 14px',
    background: active ? '#4fa3ff' : '#1c2229',
    color: active ? '#0c1118' : '#cfd5df',
    border: `1px solid ${active ? '#4fa3ff' : '#2a2f3a'}`,
    borderRadius: 8,
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 0.12s, border-color 0.12s',
  };
}
