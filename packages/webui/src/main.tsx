import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { prepareTargetAppearance } from './appearance/runtime';

const root = document.getElementById('root')!;

void prepareTargetAppearance()
    .then(() => {
        createRoot(root).render(
            <StrictMode>
                <App />
            </StrictMode>,
        );
    })
    .catch((error: unknown) => {
        console.error('[SnowLuma appearance] Startup failed', error);
        root.textContent = '界面外观加载失败，请刷新重试。详细原因见浏览器控制台。';
    });
