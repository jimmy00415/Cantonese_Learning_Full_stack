import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';

import { requireSameOrigin } from './http/security.js';
import { sendError } from './http/errors.js';
import { createSessionRouter } from './http/session.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));

function envelope(response, data, error = null) {
  return { data, error, requestId: response.locals.requestId };
}

export function createApp({ config, store, mediaStore, answerService, eventHub } = {}) {
  void mediaStore;
  void answerService;
  void eventHub;

  if (!config) throw new Error('createApp requires config');

  const app = express();
  app.set('trust proxy', config.trustedProxyHops);
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.set('X-Request-Id', requestId);
    next();
  });
  app.use(helmet());
  app.use(requireSameOrigin(config.publicOrigin));
  app.use(express.json({ limit: '64kb', type: ['application/json', 'application/*+json'] }));

  app.get('/api/health/live', (request, response) => {
    response.json(envelope(response, { status: 'ok', version: config.version ?? '0.1.0' }));
  });
  if (store) app.use('/api/v1', createSessionRouter({ config, store }));
  app.use('/api', (request, response) => {
    response.status(404).json(envelope(response, null, { code: 'NOT_FOUND', message: 'The requested API route does not exist.' }));
  });
  app.use(express.static(publicDirectory, { index: 'index.html', fallthrough: false }));
  app.use((error, request, response, next) => {
    void request;
    void next;
    if (response.headersSent) return;
    sendError(response, error);
  });

  return app;
}
