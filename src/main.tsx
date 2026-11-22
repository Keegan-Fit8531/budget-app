import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, readTheme } from './ui/theme';
import App from './app/App';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { BudgetProvider } from './state/store';
import './ui/styles/index.css';

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
