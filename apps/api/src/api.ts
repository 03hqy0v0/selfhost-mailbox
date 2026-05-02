import cors from '@fastify/cors';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import staticPlugin from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from './config.js';
import {
  createMailbox,
  deleteMailboxByAddress,
  deleteMailboxForAccess,
  deleteMessageForAccess,
  disableMailboxShare,
  enableMailboxShare,
  getAttachmentForAccess,
  getAttachmentForShare,
  getAttachmentById,
  getMailboxByAddress,
  getMailboxForAccess,
  getMailboxForShare,
  getMessageById,
  getMessageForAccess,
  getMessageForShare,
  listAttachmentsByMessageId,
  listAttachmentsForAccess,
  listAttachmentsForShare,
  listMailboxes,
  listMessages,
  updateMailboxNoteForAccess,
  updateMailboxNoteForAdmin,
  updateMailboxRetention
} from './db.js';
import {
  createAccessToken,
  hashToken,
  isValidAddress,
  isValidLocalPart,
  normalizeAddress,
  normalizeDomain,
  parseTtlHours,
  randomLocalPart,
  safeFilename,
  splitAddress
} from './utils.js';

interface CreateMailboxBody {
  address?: string;
  domain?: string;
  ttlHours?: number | null;
  permanent?: boolean;
}

interface UpdateMailboxBody {
  ttlHours?: number | null;
  permanent?: boolean;
  note?: string | null;
}

function tokenFromRequest(request: FastifyRequest): string | null {
  return singleHeaderValue(request.headers['x-mailbox-token']);
}

function adminTokenFromRequest(request: FastifyRequest): string | null {
  return singleHeaderValue(request.headers['x-admin-token']);
}

function singleHeaderValue(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) return header[0] || null;
  return header || null;
}

function requireToken(request: FastifyRequest, reply: FastifyReply): string | null {
  const token = tokenFromRequest(request);
  if (!token) {
    void reply.code(401).send({ success: false, error: 'Missing mailbox token' });
    return null;
  }

  return hashToken(token);
}

function requireAdminToken(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!appConfig.adminTokenHash) {
    void reply.code(503).send({ success: false, error: 'Admin token is not configured' });
    return false;
  }

  const token = adminTokenFromRequest(request);
  if (!token || hashToken(token) !== appConfig.adminTokenHash) {
    void reply.code(401).send({ success: false, error: 'Invalid admin token' });
    return false;
  }

  return true;
}

function isAllowedDomain(domain: string): boolean {
  return appConfig.emailDomains.includes(normalizeDomain(domain));
}

function activeTtlHours(body: CreateMailboxBody): number | null {
  if (body.permanent) return null;
  return parseTtlHours(body.ttlHours, appConfig.defaultTtlHours, appConfig.maxTtlHours);
}

function retentionTtlHours(body: UpdateMailboxBody): number | null {
  if (body.permanent) return null;
  return parseTtlHours(body.ttlHours, appConfig.defaultTtlHours, appConfig.maxTtlHours);
}

function hasRetentionUpdate(body: UpdateMailboxBody): boolean {
  return body.permanent !== undefined || body.ttlHours !== undefined;
}

function hasNoteUpdate(body: UpdateMailboxBody): boolean {
  return Object.prototype.hasOwnProperty.call(body, 'note');
}

function normalizeNote(note: string | null | undefined): string {
  const value = (note || '').trim();
  if (value.length > 80) {
    throw new Error('Note must be 80 characters or fewer');
  }

  return value;
}

function shareUrl(token: string, request: FastifyRequest): string {
  return `${publicBaseUrlForRequest(request)}/share/${encodeURIComponent(token)}`;
}

function publicBaseUrlForRequest(request: FastifyRequest): string {
  const configured = appConfig.publicBaseUrl.replace(/\/+$/, '');
  if (configured && isPublicBaseUrl(configured)) {
    return configured;
  }

  const host =
    singleHeaderValue(request.headers['x-forwarded-host']) ||
    singleHeaderValue(request.headers.host) ||
    'localhost';
  const cfVisitor = singleHeaderValue(request.headers['cf-visitor']);
  const cfScheme = cfVisitor?.match(/"scheme"\s*:\s*"([^"]+)"/)?.[1];
  const proto =
    singleHeaderValue(request.headers['x-forwarded-proto']) ||
    cfScheme ||
    (host.includes('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');

  return `${proto}://${host}`.replace(/\/+$/, '');
}

function isPublicBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !(
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '0.0.0.0' ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function resolveMailboxAddress(body: CreateMailboxBody): { address: string; localPart: string; domain: string } {
  const requestedDomain = normalizeDomain(body.domain || appConfig.emailDomains[0] || '');
  if (!requestedDomain || !isAllowedDomain(requestedDomain)) {
    throw new Error('Selected domain is not available');
  }

  if (!body.address || !body.address.trim()) {
    const localPart = randomLocalPart();
    return {
      address: `${localPart}@${requestedDomain}`,
      localPart,
      domain: requestedDomain
    };
  }

  const input = normalizeAddress(body.address);
  const parts = input.includes('@')
    ? splitAddress(input)
    : { localPart: input, domain: requestedDomain };

  if (!parts || !isAllowedDomain(parts.domain)) {
    throw new Error('Mailbox domain is not allowed');
  }

  const address = `${parts.localPart}@${parts.domain}`;
  if (!isValidLocalPart(parts.localPart) || !isValidAddress(address)) {
    throw new Error('Invalid mailbox address');
  }

  return {
    address,
    localPart: parts.localPart,
    domain: parts.domain
  };
}

export async function createHttpServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
    bodyLimit: 2 * 1024 * 1024
  });

  await app.register(cors, {
    origin: appConfig.corsOrigin === '*' ? true : appConfig.corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Mailbox-Token', 'X-Admin-Token']
  });

  app.get('/api/health', async () => ({
    success: true,
    status: 'ok'
  }));

  app.get('/api/config', async () => ({
    success: true,
    config: {
      emailDomains: appConfig.emailDomains,
      defaultTtlHours: appConfig.defaultTtlHours,
      maxTtlHours: appConfig.maxTtlHours,
      publicBaseUrl: appConfig.publicBaseUrl,
      adminEnabled: Boolean(appConfig.adminTokenHash)
    }
  }));

  app.get('/api/admin/mailboxes', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    return {
      success: true,
      mailboxes: await listMailboxes()
    };
  });

  app.get('/api/admin/mailboxes/:address/messages', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const { address } = request.params as { address: string };
    const mailbox = await getMailboxByAddress(normalizeAddress(address));
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return {
      success: true,
      messages: await listMessages(mailbox.id)
    };
  });

  app.patch('/api/admin/mailboxes/:address', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    try {
      const { address } = request.params as { address: string };
      const body = (request.body || {}) as UpdateMailboxBody;
      const mailbox = await updateMailboxNoteForAdmin(normalizeAddress(address), normalizeNote(body.note));
      if (!mailbox) {
        return reply.code(404).send({ success: false, error: 'Mailbox not found' });
      }

      return { success: true, mailbox };
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  });

  app.delete('/api/admin/mailboxes/:address', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const { address } = request.params as { address: string };
    const deleted = await deleteMailboxByAddress(normalizeAddress(address));
    if (!deleted) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return { success: true };
  });

  app.get('/api/admin/messages/:id', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const message = await getMessageById(id);
    if (!message) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true, message };
  });

  app.get('/api/admin/messages/:id/attachments', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const attachments = await listAttachmentsByMessageId(id);
    if (!attachments) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true, attachments };
  });

  app.get('/api/admin/attachments/:id/download', async (request, reply) => {
    if (!requireAdminToken(request, reply)) return;

    const { id } = request.params as { id: string };
    const attachment = await getAttachmentById(id);
    if (!attachment) {
      return reply.code(404).send({ success: false, error: 'Attachment not found' });
    }

    reply.header('Content-Type', attachment.mimeType);
    reply.header('Content-Length', attachment.content.length);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${safeFilename(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
    );

    return reply.send(attachment.content);
  });

  app.post('/api/mailboxes', async (request, reply) => {
    try {
      const body = (request.body || {}) as CreateMailboxBody;
      const ttlHours = activeTtlHours(body);
      const resolved = resolveMailboxAddress(body);
      const token = createAccessToken();
      const mailbox = await createMailbox({
        ...resolved,
        ttlHours,
        tokenHash: hashToken(token)
      });

      return reply.code(201).send({
        success: true,
        mailbox,
        token
      });
    } catch (error: any) {
      const duplicate = error?.code === '23505';
      return reply.code(duplicate ? 409 : 400).send({
        success: false,
        error: duplicate ? 'Mailbox already exists' : error.message
      });
    }
  });

  app.patch('/api/mailboxes/:address', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    try {
      const { address } = request.params as { address: string };
      const body = (request.body || {}) as UpdateMailboxBody;
      const normalizedAddress = normalizeAddress(address);
      let mailbox = hasRetentionUpdate(body)
        ? await updateMailboxRetention(normalizedAddress, tokenHash, retentionTtlHours(body))
        : await getMailboxForAccess(normalizedAddress, tokenHash);

      if (mailbox && hasNoteUpdate(body)) {
        mailbox = await updateMailboxNoteForAccess(normalizedAddress, tokenHash, normalizeNote(body.note));
      }

      if (!mailbox) {
        return reply.code(404).send({ success: false, error: 'Mailbox not found' });
      }

      return { success: true, mailbox };
    } catch (error: any) {
      return reply.code(400).send({ success: false, error: error.message });
    }
  });

  app.post('/api/mailboxes/:address/share', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { address } = request.params as { address: string };
    const shareToken = createAccessToken();
    const mailbox = await enableMailboxShare(
      normalizeAddress(address),
      tokenHash,
      hashToken(shareToken)
    );
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return {
      success: true,
      mailbox,
      share: {
        token: shareToken,
        url: shareUrl(shareToken, request)
      }
    };
  });

  app.delete('/api/mailboxes/:address/share', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { address } = request.params as { address: string };
    const mailbox = await disableMailboxShare(normalizeAddress(address), tokenHash);
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return { success: true, mailbox };
  });

  app.get('/api/shared/:shareToken/mailbox', async (request, reply) => {
    const { shareToken } = request.params as { shareToken: string };
    const mailbox = await getMailboxForShare(hashToken(shareToken));
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Shared inbox not found' });
    }

    return { success: true, mailbox };
  });

  app.get('/api/shared/:shareToken/messages', async (request, reply) => {
    const { shareToken } = request.params as { shareToken: string };
    const mailbox = await getMailboxForShare(hashToken(shareToken));
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Shared inbox not found' });
    }

    return {
      success: true,
      messages: await listMessages(mailbox.id)
    };
  });

  app.get('/api/shared/:shareToken/messages/:id', async (request, reply) => {
    const { shareToken, id } = request.params as { shareToken: string; id: string };
    const message = await getMessageForShare(id, hashToken(shareToken));
    if (!message) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true, message };
  });

  app.get('/api/shared/:shareToken/messages/:id/attachments', async (request, reply) => {
    const { shareToken, id } = request.params as { shareToken: string; id: string };
    const attachments = await listAttachmentsForShare(id, hashToken(shareToken));
    if (!attachments) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true, attachments };
  });

  app.get('/api/shared/:shareToken/attachments/:id/download', async (request, reply) => {
    const { shareToken, id } = request.params as { shareToken: string; id: string };
    const attachment = await getAttachmentForShare(id, hashToken(shareToken));
    if (!attachment) {
      return reply.code(404).send({ success: false, error: 'Attachment not found' });
    }

    reply.header('Content-Type', attachment.mimeType);
    reply.header('Content-Length', attachment.content.length);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${safeFilename(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
    );

    return reply.send(attachment.content);
  });

  app.get('/api/mailboxes/:address', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { address } = request.params as { address: string };
    const mailbox = await getMailboxForAccess(normalizeAddress(address), tokenHash);
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return { success: true, mailbox };
  });

  app.delete('/api/mailboxes/:address', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { address } = request.params as { address: string };
    const deleted = await deleteMailboxForAccess(normalizeAddress(address), tokenHash);
    if (!deleted) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return { success: true };
  });

  app.get('/api/mailboxes/:address/messages', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { address } = request.params as { address: string };
    const mailbox = await getMailboxForAccess(normalizeAddress(address), tokenHash);
    if (!mailbox) {
      return reply.code(404).send({ success: false, error: 'Mailbox not found' });
    }

    return {
      success: true,
      messages: await listMessages(mailbox.id)
    };
  });

  app.get('/api/messages/:id', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { id } = request.params as { id: string };
    const message = await getMessageForAccess(id, tokenHash);
    if (!message) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true, message };
  });

  app.delete('/api/messages/:id', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { id } = request.params as { id: string };
    const deleted = await deleteMessageForAccess(id, tokenHash);
    if (!deleted) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true };
  });

  app.get('/api/messages/:id/attachments', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { id } = request.params as { id: string };
    const attachments = await listAttachmentsForAccess(id, tokenHash);
    if (!attachments) {
      return reply.code(404).send({ success: false, error: 'Message not found' });
    }

    return { success: true, attachments };
  });

  app.get('/api/attachments/:id/download', async (request, reply) => {
    const tokenHash = requireToken(request, reply);
    if (!tokenHash) return;

    const { id } = request.params as { id: string };
    const attachment = await getAttachmentForAccess(id, tokenHash);
    if (!attachment) {
      return reply.code(404).send({ success: false, error: 'Attachment not found' });
    }

    reply.header('Content-Type', attachment.mimeType);
    reply.header('Content-Length', attachment.content.length);
    reply.header(
      'Content-Disposition',
      `attachment; filename="${safeFilename(attachment.filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`
    );

    return reply.send(attachment.content);
  });

  await registerStaticFrontend(app);
  return app;
}

async function registerStaticFrontend(app: FastifyInstance): Promise<void> {
  const webDist = appConfig.webDist || path.resolve(process.cwd(), 'apps/web/dist');
  if (!fs.existsSync(path.join(webDist, 'index.html'))) return;

  await app.register(staticPlugin, {
    root: webDist,
    prefix: '/'
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.raw.method === 'GET' && !request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }

    return reply.code(404).send({ success: false, error: 'Not found' });
  });
}
