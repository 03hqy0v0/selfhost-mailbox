export interface AppConfig {
  emailDomains: string[];
  defaultTtlHours: number;
  maxTtlHours: number;
  publicBaseUrl: string;
}

export interface Mailbox {
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

export interface ShareInfo {
  token: string;
  url: string;
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with ${response.status}`);
  }

  return payload as T;
}

function tokenHeader(token: string): HeadersInit {
  return {
    'X-Mailbox-Token': token
  };
}

export async function getConfig(): Promise<AppConfig> {
  const result = await request<{ success: true; config: AppConfig }>('/api/config');
  return result.config;
}

export async function createMailbox(input: {
  address?: string;
  domain: string;
  ttlHours?: number | null;
  permanent?: boolean;
}): Promise<{ mailbox: Mailbox; token: string }> {
  const result = await request<{ success: true; mailbox: Mailbox; token: string }>('/api/mailboxes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(input)
  });

  return {
    mailbox: result.mailbox,
    token: result.token
  };
}

export async function createMailboxShare(address: string, token: string): Promise<{ mailbox: Mailbox; share: ShareInfo }> {
  const result = await request<{ success: true; mailbox: Mailbox; share: ShareInfo }>(
    `/api/mailboxes/${encodeURIComponent(address)}/share`,
    {
      method: 'POST',
      headers: tokenHeader(token)
    }
  );

  return {
    mailbox: result.mailbox,
    share: result.share
  };
}

export async function disableMailboxShare(address: string, token: string): Promise<Mailbox> {
  const result = await request<{ success: true; mailbox: Mailbox }>(
    `/api/mailboxes/${encodeURIComponent(address)}/share`,
    {
      method: 'DELETE',
      headers: tokenHeader(token)
    }
  );

  return result.mailbox;
}

export async function getMailbox(address: string, token: string): Promise<Mailbox> {
  const result = await request<{ success: true; mailbox: Mailbox }>(
    `/api/mailboxes/${encodeURIComponent(address)}`,
    {
      headers: tokenHeader(token)
    }
  );

  return result.mailbox;
}

export async function updateMailboxRetention(
  address: string,
  token: string,
  input: { ttlHours?: number | null; permanent?: boolean }
): Promise<Mailbox> {
  const result = await request<{ success: true; mailbox: Mailbox }>(
    `/api/mailboxes/${encodeURIComponent(address)}`,
    {
      method: 'PATCH',
      headers: {
        ...tokenHeader(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    }
  );

  return result.mailbox;
}

export async function deleteMailbox(address: string, token: string): Promise<void> {
  await request(`/api/mailboxes/${encodeURIComponent(address)}`, {
    method: 'DELETE',
    headers: tokenHeader(token)
  });
}

export async function listMessages(address: string, token: string): Promise<MessageListItem[]> {
  const result = await request<{ success: true; messages: MessageListItem[] }>(
    `/api/mailboxes/${encodeURIComponent(address)}/messages`,
    {
      headers: tokenHeader(token)
    }
  );

  return result.messages;
}

export async function getMessage(id: string, token: string): Promise<MessageRecord> {
  const result = await request<{ success: true; message: MessageRecord }>(`/api/messages/${id}`, {
    headers: tokenHeader(token)
  });

  return result.message;
}

export async function deleteMessage(id: string, token: string): Promise<void> {
  await request(`/api/messages/${id}`, {
    method: 'DELETE',
    headers: tokenHeader(token)
  });
}

export async function listAttachments(id: string, token: string): Promise<AttachmentRecord[]> {
  const result = await request<{ success: true; attachments: AttachmentRecord[] }>(
    `/api/messages/${id}/attachments`,
    {
      headers: tokenHeader(token)
    }
  );

  return result.attachments;
}

export async function downloadAttachment(attachment: AttachmentRecord, token: string): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/attachments/${attachment.id}/download`, {
    headers: tokenHeader(token)
  });

  await downloadBlob(response, attachment.filename);
}

export async function getSharedMailbox(shareToken: string): Promise<Mailbox> {
  const result = await request<{ success: true; mailbox: Mailbox }>(
    `/api/shared/${encodeURIComponent(shareToken)}/mailbox`
  );

  return result.mailbox;
}

export async function listSharedMessages(shareToken: string): Promise<MessageListItem[]> {
  const result = await request<{ success: true; messages: MessageListItem[] }>(
    `/api/shared/${encodeURIComponent(shareToken)}/messages`
  );

  return result.messages;
}

export async function getSharedMessage(shareToken: string, id: string): Promise<MessageRecord> {
  const result = await request<{ success: true; message: MessageRecord }>(
    `/api/shared/${encodeURIComponent(shareToken)}/messages/${id}`
  );

  return result.message;
}

export async function listSharedAttachments(shareToken: string, id: string): Promise<AttachmentRecord[]> {
  const result = await request<{ success: true; attachments: AttachmentRecord[] }>(
    `/api/shared/${encodeURIComponent(shareToken)}/messages/${id}/attachments`
  );

  return result.attachments;
}

export async function downloadSharedAttachment(shareToken: string, attachment: AttachmentRecord): Promise<void> {
  const response = await fetch(
    `${API_BASE_URL}/api/shared/${encodeURIComponent(shareToken)}/attachments/${attachment.id}/download`
  );

  await downloadBlob(response, attachment.filename);
}

async function downloadBlob(response: Response, filename: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`Download failed with ${response.status}`);
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
