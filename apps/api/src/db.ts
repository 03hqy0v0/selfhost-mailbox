import crypto from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { appConfig } from './config.js';
import { toIsoString } from './utils.js';

export interface MailboxRecord {
  id: string;
  address: string;
  localPart: string;
  domain: string;
  createdAt: string;
  expiresAt: string | null;
  lastAccessed: string;
}

export interface MessageListItem {
  id: string;
  mailboxId: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  subject: string;
  preview: string;
  receivedAt: string;
  hasAttachments: boolean;
  isRead: boolean;
}

export interface MessageRecord extends MessageListItem {
  textBody: string;
  htmlBody: string;
  messageId: string | null;
  sizeBytes: number;
}

export interface AttachmentRecord {
  id: string;
  messageId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface AttachmentDownload extends AttachmentRecord {
  content: Buffer;
}

export interface SaveAttachmentInput {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  content: Buffer;
}

export interface SaveMessageInput {
  mailboxId: string;
  envelopeFrom: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  subject: string;
  textBody: string;
  htmlBody: string;
  messageId: string | null;
  sizeBytes: number;
  attachments: SaveAttachmentInput[];
}

const pool = new Pool({
  connectionString: appConfig.databaseUrl
});

const mailboxSelect = `
  id,
  address,
  local_part AS "localPart",
  domain,
  created_at AS "createdAt",
  expires_at AS "expiresAt",
  last_accessed AS "lastAccessed"
`;

function mapMailbox(row: any): MailboxRecord {
  return {
    id: row.id,
    address: row.address,
    localPart: row.localPart,
    domain: row.domain,
    createdAt: toIsoString(row.createdAt),
    expiresAt: row.expiresAt ? toIsoString(row.expiresAt) : null,
    lastAccessed: toIsoString(row.lastAccessed)
  };
}

function mapMessage(row: any): MessageRecord {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    toAddress: row.toAddress,
    subject: row.subject,
    preview: row.preview || '',
    textBody: row.textBody || '',
    htmlBody: row.htmlBody || '',
    messageId: row.messageId,
    sizeBytes: Number(row.sizeBytes || 0),
    receivedAt: toIsoString(row.receivedAt),
    hasAttachments: Boolean(row.hasAttachments),
    isRead: Boolean(row.isRead)
  };
}

function mapAttachment(row: any): AttachmentRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: Number(row.sizeBytes || 0),
    createdAt: toIsoString(row.createdAt)
  };
}

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mailboxes (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      local_part TEXT NOT NULL,
      domain TEXT NOT NULL,
      access_token_hash TEXT NOT NULL,
      share_token_hash TEXT,
      share_created_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      last_accessed TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      mailbox_id TEXT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
      envelope_from TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      to_address TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      text_body TEXT NOT NULL DEFAULT '',
      html_body TEXT NOT NULL DEFAULT '',
      message_id TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      has_attachments BOOLEAN NOT NULL DEFAULT false,
      is_read BOOLEAN NOT NULL DEFAULT false
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      content BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);
    CREATE INDEX IF NOT EXISTS idx_mailboxes_domain ON mailboxes(domain);
    CREATE INDEX IF NOT EXISTS idx_mailboxes_expires_at ON mailboxes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received ON messages(mailbox_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    ALTER TABLE mailboxes
      ADD COLUMN IF NOT EXISTS share_token_hash TEXT,
      ADD COLUMN IF NOT EXISTS share_created_at TIMESTAMPTZ;

    ALTER TABLE mailboxes
      ALTER COLUMN expires_at DROP NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_share_token_hash
      ON mailboxes(share_token_hash)
      WHERE share_token_hash IS NOT NULL;
  `);

  const preserveExisting = await pool.query(
    `
      INSERT INTO schema_migrations (id)
      VALUES ('preserve-existing-mailboxes-2026-05-01')
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `
  );

  if ((preserveExisting.rowCount || 0) > 0) {
    await pool.query('UPDATE mailboxes SET expires_at = NULL WHERE expires_at IS NOT NULL');
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}

export async function createMailbox(input: {
  address: string;
  localPart: string;
  domain: string;
  tokenHash: string;
  ttlHours: number | null;
}): Promise<MailboxRecord> {
  const result = await pool.query(
    `
      INSERT INTO mailboxes (id, address, local_part, domain, access_token_hash, expires_at)
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        CASE WHEN $6::integer IS NULL THEN NULL ELSE now() + ($6::integer * interval '1 hour') END
      )
      RETURNING ${mailboxSelect}
    `,
    [cryptoRandomId(), input.address, input.localPart, input.domain, input.tokenHash, input.ttlHours]
  );

  return mapMailbox(result.rows[0]);
}

export async function getActiveMailboxByAddress(address: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      UPDATE mailboxes
      SET last_accessed = now()
      WHERE address = $1 AND (expires_at IS NULL OR expires_at > now())
      RETURNING ${mailboxSelect}
    `,
    [address]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function listMailboxes(): Promise<MailboxRecord[]> {
  const result = await pool.query(
    `
      SELECT ${mailboxSelect}
      FROM mailboxes
      ORDER BY created_at DESC
    `
  );

  return result.rows.map(mapMailbox);
}

export async function getMailboxByAddress(address: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      SELECT ${mailboxSelect}
      FROM mailboxes
      WHERE address = $1
    `,
    [address]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function getMailboxForAccess(address: string, tokenHash: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      UPDATE mailboxes
      SET last_accessed = now()
      WHERE address = $1 AND access_token_hash = $2 AND (expires_at IS NULL OR expires_at > now())
      RETURNING ${mailboxSelect}
    `,
    [address, tokenHash]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function updateMailboxRetention(
  address: string,
  tokenHash: string,
  ttlHours: number | null
): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      UPDATE mailboxes
      SET
        expires_at = CASE
          WHEN $3::integer IS NULL THEN NULL
          ELSE now() + ($3::integer * interval '1 hour')
        END,
        last_accessed = now()
      WHERE address = $1 AND access_token_hash = $2 AND (expires_at IS NULL OR expires_at > now())
      RETURNING ${mailboxSelect}
    `,
    [address, tokenHash, ttlHours]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function deleteMailboxForAccess(address: string, tokenHash: string): Promise<boolean> {
  const result = await pool.query(
    'DELETE FROM mailboxes WHERE address = $1 AND access_token_hash = $2',
    [address, tokenHash]
  );

  return (result.rowCount || 0) > 0;
}

export async function enableMailboxShare(
  address: string,
  tokenHash: string,
  shareTokenHash: string
): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      UPDATE mailboxes
      SET share_token_hash = $3, share_created_at = now(), last_accessed = now()
      WHERE address = $1 AND access_token_hash = $2 AND (expires_at IS NULL OR expires_at > now())
      RETURNING ${mailboxSelect}
    `,
    [address, tokenHash, shareTokenHash]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function disableMailboxShare(address: string, tokenHash: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      UPDATE mailboxes
      SET share_token_hash = NULL, share_created_at = NULL, last_accessed = now()
      WHERE address = $1 AND access_token_hash = $2 AND (expires_at IS NULL OR expires_at > now())
      RETURNING ${mailboxSelect}
    `,
    [address, tokenHash]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function getMailboxForShare(shareTokenHash: string): Promise<MailboxRecord | null> {
  const result = await pool.query(
    `
      UPDATE mailboxes
      SET last_accessed = now()
      WHERE share_token_hash = $1 AND (expires_at IS NULL OR expires_at > now())
      RETURNING ${mailboxSelect}
    `,
    [shareTokenHash]
  );

  return result.rows[0] ? mapMailbox(result.rows[0]) : null;
}

export async function saveMessage(input: SaveMessageInput): Promise<MessageRecord> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const message = await insertMessage(client, input);

    for (const attachment of input.attachments) {
      await client.query(
        `
          INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, content)
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          cryptoRandomId(),
          message.id,
          attachment.filename,
          attachment.mimeType,
          attachment.sizeBytes,
          attachment.content
        ]
      );
    }

    await client.query('COMMIT');
    return message;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function insertMessage(client: PoolClient, input: SaveMessageInput): Promise<MessageRecord> {
  const result = await client.query(
    `
      INSERT INTO messages (
        id,
        mailbox_id,
        envelope_from,
        from_address,
        from_name,
        to_address,
        subject,
        text_body,
        html_body,
        message_id,
        size_bytes,
        has_attachments
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING
        id,
        mailbox_id AS "mailboxId",
        from_address AS "fromAddress",
        from_name AS "fromName",
        to_address AS "toAddress",
        subject,
        left(text_body, 240) AS preview,
        text_body AS "textBody",
        html_body AS "htmlBody",
        message_id AS "messageId",
        size_bytes AS "sizeBytes",
        received_at AS "receivedAt",
        has_attachments AS "hasAttachments",
        is_read AS "isRead"
    `,
    [
      cryptoRandomId(),
      input.mailboxId,
      input.envelopeFrom,
      input.fromAddress,
      input.fromName,
      input.toAddress,
      input.subject,
      input.textBody,
      input.htmlBody,
      input.messageId,
      input.sizeBytes,
      input.attachments.length > 0
    ]
  );

  return mapMessage(result.rows[0]);
}

export async function listMessages(mailboxId: string): Promise<MessageListItem[]> {
  const result = await pool.query(
    `
      SELECT
        id,
        mailbox_id AS "mailboxId",
        from_address AS "fromAddress",
        from_name AS "fromName",
        to_address AS "toAddress",
        subject,
        left(text_body, 240) AS preview,
        '' AS "textBody",
        '' AS "htmlBody",
        message_id AS "messageId",
        size_bytes AS "sizeBytes",
        received_at AS "receivedAt",
        has_attachments AS "hasAttachments",
        is_read AS "isRead"
      FROM messages
      WHERE mailbox_id = $1
      ORDER BY received_at DESC
    `,
    [mailboxId]
  );

  return result.rows.map(mapMessage);
}

export async function getMessageForAccess(messageId: string, tokenHash: string): Promise<MessageRecord | null> {
  const result = await pool.query(
    `
      UPDATE messages
      SET is_read = true
      WHERE id = $1
        AND mailbox_id IN (
          SELECT id FROM mailboxes WHERE access_token_hash = $2 AND (expires_at IS NULL OR expires_at > now())
        )
      RETURNING
        id,
        mailbox_id AS "mailboxId",
        from_address AS "fromAddress",
        from_name AS "fromName",
        to_address AS "toAddress",
        subject,
        left(text_body, 240) AS preview,
        text_body AS "textBody",
        html_body AS "htmlBody",
        message_id AS "messageId",
        size_bytes AS "sizeBytes",
        received_at AS "receivedAt",
        has_attachments AS "hasAttachments",
        is_read AS "isRead"
    `,
    [messageId, tokenHash]
  );

  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

export async function getMessageForShare(messageId: string, shareTokenHash: string): Promise<MessageRecord | null> {
  const result = await pool.query(
    `
      SELECT
        m.id,
        m.mailbox_id AS "mailboxId",
        m.from_address AS "fromAddress",
        m.from_name AS "fromName",
        m.to_address AS "toAddress",
        m.subject,
        left(m.text_body, 240) AS preview,
        m.text_body AS "textBody",
        m.html_body AS "htmlBody",
        m.message_id AS "messageId",
        m.size_bytes AS "sizeBytes",
        m.received_at AS "receivedAt",
        m.has_attachments AS "hasAttachments",
        m.is_read AS "isRead"
      FROM messages m
      JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.id = $1
        AND b.share_token_hash = $2
        AND (b.expires_at IS NULL OR b.expires_at > now())
    `,
    [messageId, shareTokenHash]
  );

  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

export async function getMessageById(messageId: string): Promise<MessageRecord | null> {
  const result = await pool.query(
    `
      SELECT
        id,
        mailbox_id AS "mailboxId",
        from_address AS "fromAddress",
        from_name AS "fromName",
        to_address AS "toAddress",
        subject,
        left(text_body, 240) AS preview,
        text_body AS "textBody",
        html_body AS "htmlBody",
        message_id AS "messageId",
        size_bytes AS "sizeBytes",
        received_at AS "receivedAt",
        has_attachments AS "hasAttachments",
        is_read AS "isRead"
      FROM messages
      WHERE id = $1
    `,
    [messageId]
  );

  return result.rows[0] ? mapMessage(result.rows[0]) : null;
}

export async function deleteMessageForAccess(messageId: string, tokenHash: string): Promise<boolean> {
  const result = await pool.query(
    `
      DELETE FROM messages
      WHERE id = $1
        AND mailbox_id IN (
          SELECT id FROM mailboxes WHERE access_token_hash = $2 AND (expires_at IS NULL OR expires_at > now())
        )
    `,
    [messageId, tokenHash]
  );

  return (result.rowCount || 0) > 0;
}

export async function listAttachmentsForAccess(
  messageId: string,
  tokenHash: string
): Promise<AttachmentRecord[] | null> {
  const allowed = await pool.query(
    `
      SELECT 1
      FROM messages m
      JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.id = $1 AND b.access_token_hash = $2 AND (b.expires_at IS NULL OR b.expires_at > now())
    `,
    [messageId, tokenHash]
  );

  if (!allowed.rows[0]) return null;

  const result = await pool.query(
    `
      SELECT
        id,
        message_id AS "messageId",
        filename,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        created_at AS "createdAt"
      FROM attachments
      WHERE message_id = $1
      ORDER BY created_at ASC
    `,
    [messageId]
  );

  return result.rows.map(mapAttachment);
}

export async function listAttachmentsForShare(
  messageId: string,
  shareTokenHash: string
): Promise<AttachmentRecord[] | null> {
  const allowed = await pool.query(
    `
      SELECT 1
      FROM messages m
      JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE m.id = $1
        AND b.share_token_hash = $2
        AND (b.expires_at IS NULL OR b.expires_at > now())
    `,
    [messageId, shareTokenHash]
  );

  if (!allowed.rows[0]) return null;

  const result = await pool.query(
    `
      SELECT
        id,
        message_id AS "messageId",
        filename,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        created_at AS "createdAt"
      FROM attachments
      WHERE message_id = $1
      ORDER BY created_at ASC
    `,
    [messageId]
  );

  return result.rows.map(mapAttachment);
}

export async function listAttachmentsByMessageId(messageId: string): Promise<AttachmentRecord[] | null> {
  const allowed = await pool.query('SELECT 1 FROM messages WHERE id = $1', [messageId]);
  if (!allowed.rows[0]) return null;

  const result = await pool.query(
    `
      SELECT
        id,
        message_id AS "messageId",
        filename,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        created_at AS "createdAt"
      FROM attachments
      WHERE message_id = $1
      ORDER BY created_at ASC
    `,
    [messageId]
  );

  return result.rows.map(mapAttachment);
}

export async function getAttachmentForAccess(
  attachmentId: string,
  tokenHash: string
): Promise<AttachmentDownload | null> {
  const result = await pool.query(
    `
      SELECT
        a.id,
        a.message_id AS "messageId",
        a.filename,
        a.mime_type AS "mimeType",
        a.size_bytes AS "sizeBytes",
        a.created_at AS "createdAt",
        a.content
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
      JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE a.id = $1 AND b.access_token_hash = $2 AND (b.expires_at IS NULL OR b.expires_at > now())
    `,
    [attachmentId, tokenHash]
  );

  if (!result.rows[0]) return null;

  return {
    ...mapAttachment(result.rows[0]),
    content: result.rows[0].content
  };
}

export async function getAttachmentForShare(
  attachmentId: string,
  shareTokenHash: string
): Promise<AttachmentDownload | null> {
  const result = await pool.query(
    `
      SELECT
        a.id,
        a.message_id AS "messageId",
        a.filename,
        a.mime_type AS "mimeType",
        a.size_bytes AS "sizeBytes",
        a.created_at AS "createdAt",
        a.content
      FROM attachments a
      JOIN messages m ON m.id = a.message_id
      JOIN mailboxes b ON b.id = m.mailbox_id
      WHERE a.id = $1
        AND b.share_token_hash = $2
        AND (b.expires_at IS NULL OR b.expires_at > now())
    `,
    [attachmentId, shareTokenHash]
  );

  if (!result.rows[0]) return null;

  return {
    ...mapAttachment(result.rows[0]),
    content: result.rows[0].content
  };
}

export async function getAttachmentById(attachmentId: string): Promise<AttachmentDownload | null> {
  const result = await pool.query(
    `
      SELECT
        id,
        message_id AS "messageId",
        filename,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        created_at AS "createdAt",
        content
      FROM attachments
      WHERE id = $1
    `,
    [attachmentId]
  );

  if (!result.rows[0]) return null;

  return {
    ...mapAttachment(result.rows[0]),
    content: result.rows[0].content
  };
}

export async function cleanupExpired(): Promise<{ mailboxes: number }> {
  const result = await pool.query('DELETE FROM mailboxes WHERE expires_at IS NOT NULL AND expires_at <= now()');
  return { mailboxes: result.rowCount || 0 };
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}
