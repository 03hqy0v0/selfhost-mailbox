import fs from 'node:fs';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import type { SMTPServerAddress, SMTPServerAuthentication, SMTPServerSession } from 'smtp-server';
import { appConfig } from './config.js';
import { getActiveMailboxByAddress, saveMessage, type SaveAttachmentInput } from './db.js';
import { normalizeAddress, splitAddress } from './utils.js';

interface SmtpServerError extends Error {
  responseCode?: number;
}

function smtpError(message: string, responseCode: number): SmtpServerError {
  const error = new Error(message) as SmtpServerError;
  error.responseCode = responseCode;
  return error;
}

function addressFromObject(value: AddressObject | undefined): { address: string; name: string } {
  const first = value?.value?.[0];
  return {
    address: normalizeAddress(first?.address || ''),
    name: first?.name || ''
  };
}

function htmlBody(parsed: ParsedMail): string {
  if (typeof parsed.html === 'string') return parsed.html;
  return '';
}

function collectMessage(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;

    stream.on('data', (chunk: Buffer | string) => {
      if (rejected) return;

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > appConfig.maxMessageBytes) {
        rejected = true;
        reject(smtpError('Message too large', 552));
        return;
      }

      chunks.push(buffer);
    });

    stream.on('error', reject);
    stream.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
  });
}

function tlsOptions(): { key: Buffer; cert: Buffer } | undefined {
  if (!appConfig.smtpTlsKeyPath || !appConfig.smtpTlsCertPath) return undefined;

  return {
    key: fs.readFileSync(appConfig.smtpTlsKeyPath),
    cert: fs.readFileSync(appConfig.smtpTlsCertPath)
  };
}

function validateRecipient(address: string, done: (error?: Error | null) => void): void {
  const normalized = normalizeAddress(address);
  const parts = splitAddress(normalized);

  if (!parts || !appConfig.emailDomains.includes(parts.domain)) {
    done(smtpError('Domain not accepted', 550));
    return;
  }

  void getActiveMailboxByAddress(normalized)
    .then((mailbox) => {
      if (!mailbox) {
        done(smtpError('Mailbox does not exist or has expired', 550));
        return;
      }

      done();
    })
    .catch((error) => done(error));
}

function matchingRecipients(session: SMTPServerSession): string[] {
  return session.envelope.rcptTo
    .map((recipient) => normalizeAddress(recipient.address))
    .filter((address, index, all) => address && all.indexOf(address) === index);
}

function envelopeFrom(session: SMTPServerSession): string {
  const mailFrom = session.envelope.mailFrom;
  if (!mailFrom) return '';
  return normalizeAddress(mailFrom.address || '');
}

function attachmentsFromParsed(parsed: ParsedMail): SaveAttachmentInput[] {
  return parsed.attachments.map((attachment) => ({
    filename: attachment.filename || 'attachment',
    mimeType: attachment.contentType || 'application/octet-stream',
    sizeBytes: attachment.size || attachment.content.length,
    content: attachment.content
  }));
}

async function storeParsedMessage(raw: Buffer, session: SMTPServerSession): Promise<number> {
  const parsed = await simpleParser(raw);
  const from = addressFromObject(parsed.from);
  const attachments = attachmentsFromParsed(parsed);
  let savedCount = 0;

  for (const recipient of matchingRecipients(session)) {
    const mailbox = await getActiveMailboxByAddress(recipient);
    if (!mailbox) continue;

    await saveMessage({
      mailboxId: mailbox.id,
      envelopeFrom: envelopeFrom(session),
      fromAddress: from.address,
      fromName: from.name,
      toAddress: recipient,
      subject: parsed.subject || '',
      textBody: parsed.text || '',
      htmlBody: htmlBody(parsed),
      messageId: parsed.messageId || null,
      sizeBytes: raw.length,
      attachments
    });

    savedCount += 1;
  }

  return savedCount;
}

export async function startSmtpServer(): Promise<SMTPServer> {
  const tls = tlsOptions();
  const server = new SMTPServer({
    banner: 'Selfhost Mailbox',
    authOptional: true,
    disabledCommands: ['AUTH'],
    hideSTARTTLS: !tls,
    size: appConfig.maxMessageBytes,
    logger: false,
    ...(tls || {}),
    onAuth(_auth: SMTPServerAuthentication, _session, callback) {
      callback(smtpError('Authentication is disabled', 502));
    },
    onMailFrom(_address: SMTPServerAddress, _session, callback) {
      callback();
    },
    onRcptTo(address: SMTPServerAddress, _session, callback) {
      validateRecipient(address.address, callback);
    },
    onData(stream, session, callback) {
      void collectMessage(stream)
        .then((raw) => storeParsedMessage(raw, session))
        .then((count) => {
          if (count === 0) {
            callback(smtpError('No accepted recipient found', 550));
            return;
          }

          callback();
        })
        .catch((error) => callback(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(appConfig.smtpPort, appConfig.smtpHost, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return server;
}
