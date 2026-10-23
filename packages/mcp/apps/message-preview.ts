import { App } from '@modelcontextprotocol/ext-apps';
import { mountMessagePreview } from './preview-view.js';

const app = new App(
    { name: 'SnowLuma 消息预览', version: '1.0.0' },
    {},
    { strict: true, autoResize: true },
);
mountMessagePreview(app, document);
