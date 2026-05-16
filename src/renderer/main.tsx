import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element not found');
const root = createRoot(rootEl);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
