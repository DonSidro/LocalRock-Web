import { createServer } from 'node:http';
import { App } from './app.js';
import { config, isLoopbackHost } from './config.js';
import { attachWebSocket, createHttp } from './http.js';
import { log } from './log.js';

if (!isLoopbackHost(config.host) && !config.password && !config.insecureLan) {
  log.error(
    `Refusing to serve on ${config.host} without a password: anyone on the network could control your robots ` +
    'and read your server session. Set LOCALROCK_PASSWORD, or set LOCALROCK_INSECURE_LAN=1 to accept the risk.',
  );
  process.exit(1);
}

const app = new App();
const server = createServer(createHttp(app));
attachWebSocket(server, app);

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') log.error(`Port ${config.port} on ${config.host} is already in use. Stop the other program or set PORT to another port.`);
  else log.error(`Could not start the web server: ${e.message}`);
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  const shown = config.host.includes(':') ? `[${config.host}]` : config.host;
  log.info(`LocalRock Web on http://${shown}:${config.port}`);
  log.info(`Data folder: ${config.dataDir}`);
  if (config.password) log.info('The page asks for LOCALROCK_PASSWORD.');
});

function shutdown(): void {
  log.info('Shutting down');
  app.link.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (e) => log.error(`Unhandled rejection: ${(e as Error)?.stack ?? String(e)}`));
