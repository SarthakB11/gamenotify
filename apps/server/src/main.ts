import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig();
const app = await buildApp(config);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.server.log.info({ signal }, 'shutting down');
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.server.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.server.listen({ host: config.host, port: config.port });
app.server.log.info(`Notification server ready on http://localhost:${config.port}`);
