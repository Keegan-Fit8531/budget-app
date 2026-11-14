import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme, readTheme } from './lib/theme';
import App from './App';
import { BudgetProvider } from './lib/store';
import './index.css';

applyTheme(readTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BudgetProvider>
      <App />
    </BudgetProvider>
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
