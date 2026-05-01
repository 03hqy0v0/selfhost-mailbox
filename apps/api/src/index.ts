import { createHttpServer } from './api.js';
import { appConfig } from './config.js';
import { cleanupExpired, closePool, migrate } from './db.js';
import { startSmtpServer } from './smtp.js';

async function main(): Promise<void> {
  await migrate();

  const http = await createHttpServer();
  await http.listen({
    host: appConfig.httpHost,
    port: appConfig.httpPort
  });

  const smtp = await startSmtpServer();
  http.log.info(`SMTP listening on ${appConfig.smtpHost}:${appConfig.smtpPort}`);
  http.log.info(`Accepted email domains: ${appConfig.emailDomains.join(', ')}`);

  const cleanupTimer = setInterval(() => {
    void cleanupExpired()
      .then((result) => {
        if (result.mailboxes > 0) {
          http.log.info(`Cleaned ${result.mailboxes} expired mailboxes`);
        }
      })
      .catch((error) => http.log.error({ error }, 'Cleanup failed'));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();

  async function shutdown(signal: string): Promise<void> {
    http.log.info(`Received ${signal}, shutting down`);
    clearInterval(cleanupTimer);
    await http.close();
    await new Promise<void>((resolve) => smtp.close(() => resolve()));
    await closePool();
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
