import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, readTheme } from './lib/theme';
import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BudgetProvider } from './lib/store';
import './index.css';

applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* The last resort: anything outside a page's own boundary is shown as a message, never a blank screen. */}
    <ErrorBoundary>
      <BudgetProvider>
        <App />
      </BudgetProvider>
    </ErrorBoundary>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
