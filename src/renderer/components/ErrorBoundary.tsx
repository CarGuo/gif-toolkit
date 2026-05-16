import React from 'react';

interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: 'var(--text)', background: 'var(--panel)', height: '100vh', boxSizing: 'border-box' }}>
          <h2 style={{ marginTop: 0 }}>出错了</h2>
          <p style={{ color: 'var(--muted)' }}>渲染过程中发生异常,可点击重置或重启应用。</p>
          <pre style={{
            background: '#0c0c0c',
            color: '#f88',
            padding: 12,
            borderRadius: 6,
            overflow: 'auto',
            maxHeight: 320,
            fontSize: 12
          }}>{String(this.state.error?.stack || this.state.error?.message)}</pre>
          <button className="primary" onClick={this.reset}>重置</button>
        </div>
      );
    }
    return this.props.children;
  }
}
