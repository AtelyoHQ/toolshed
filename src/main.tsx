import { StrictMode } from 'react';
import { netGuard } from './lib/netguard';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

// As early as a module can manage. Module bodies above have already run, so
// this is not literally first; see the note on netGuard().
netGuard();

const root = document.getElementById('root');
if (!root) throw new Error('Root element missing from index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
