import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../app/globals.css';
import { GooseGame } from '../app/goose-game';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Kalamazoo Goose could not find its page root.');
}

createRoot(root).render(
  <StrictMode>
    <GooseGame />
  </StrictMode>,
);
