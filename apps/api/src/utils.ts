import crypto from 'node:crypto';

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^@/, '');
}

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function splitAddress(address: string): { localPart: string; domain: string } | null {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return null;

  return {
    localPart: normalized.slice(0, at),
    domain: normalizeDomain(normalized.slice(at + 1))
  };
}

export function isValidLocalPart(localPart: string): boolean {
  return /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/.test(localPart);
}

export function isValidDomain(domain: string): boolean {
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain);
}

export function isValidAddress(address: string): boolean {
  const parts = splitAddress(address);
  return !!parts && isValidLocalPart(parts.localPart) && isValidDomain(parts.domain);
}

export function randomLocalPart(): string {
  return crypto.randomBytes(8).toString('base64url').toLowerCase();
}

export function createAccessToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function toIsoString(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function parseTtlHours(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('ttlHours must be an integer');
  }
  if (value < 1 || value > max) {
    throw new Error(`ttlHours must be between 1 and ${max}`);
  }

  return value;
}

export function safeFilename(filename: string): string {
  return filename.replace(/[\r\n"]/g, '_') || 'attachment';
}
