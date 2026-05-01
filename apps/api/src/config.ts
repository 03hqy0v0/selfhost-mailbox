import 'dotenv/config';
import fs from 'node:fs';

function parseInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }

  return parsed;
}

function parseDomains(value: string | undefined): string[] {
  return (value || 'example.com')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

function optionalReadableFile(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  if (!fs.existsSync(value)) {
    throw new Error(`${name} points to a missing file: ${value}`);
  }

  return value;
}

export const appConfig = {
  databaseUrl: process.env.DATABASE_URL || 'postgres://mailbox:mailbox@localhost:5432/mailbox',
  emailDomains: parseDomains(process.env.EMAIL_DOMAINS),
  httpHost: process.env.HTTP_HOST || '0.0.0.0',
  httpPort: parseInteger('HTTP_PORT', 3000),
  smtpHost: process.env.SMTP_HOST || '0.0.0.0',
  smtpPort: parseInteger('SMTP_PORT', 2525),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:3000',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  defaultTtlHours: parseInteger('DEFAULT_TTL_HOURS', 24),
  maxTtlHours: parseInteger('MAX_TTL_HOURS', 168),
  maxMessageBytes: parseInteger('MAX_MESSAGE_BYTES', 25 * 1024 * 1024),
  webDist: process.env.WEB_DIST,
  smtpTlsKeyPath: optionalReadableFile('SMTP_TLS_KEY_PATH'),
  smtpTlsCertPath: optionalReadableFile('SMTP_TLS_CERT_PATH')
};
