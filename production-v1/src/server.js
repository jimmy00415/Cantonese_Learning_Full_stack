import { createApp } from './app.js';
import { loadConfig } from './config.js';

export function startServer() {
  const config = loadConfig();
  const port = Number(process.env.PORT ?? 3000);
  const app = createApp({ config });
  return app.listen(port);
}

if (process.argv[1] && import.meta.url === new URL(`file:${process.argv[1]}`).href) {
  startServer();
}
