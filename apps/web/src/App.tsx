import {
  Copy,
  Download,
  Inbox,
  Mail,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AppConfig,
  type AttachmentRecord,
  type Mailbox,
  type MessageListItem,
  type MessageRecord,
  createMailbox,
  deleteMailbox,
  deleteMessage,
  downloadAttachment,
  getConfig,
  getMailbox,
  getMessage,
  listAttachments,
  listMessages
} from './api';

interface StoredMailbox {
  mailbox: Mailbox;
  token: string;
}

const STORAGE_KEY = 'selfhost-mailbox.current';

function readStoredMailbox(): StoredMailbox | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredMailbox;
    if (!parsed.mailbox?.address || !parsed.token) return null;
    if (new Date(parsed.mailbox.expiresAt).getTime() <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredMailbox(value: StoredMailbox | null): void {
  if (!value) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }

  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [stored, setStored] = useState<StoredMailbox | null>(() => readStoredMailbox());
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [selected, setSelected] = useState<MessageRecord | null>(null);
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mailbox = stored?.mailbox || null;
  const token = stored?.token || '';

  const expiresLabel = useMemo(() => {
    if (!mailbox) return '';
    const diff = new Date(mailbox.expiresAt).getTime() - Date.now();
    if (diff <= 0) return '已过期';
    const hours = Math.floor(diff / 1000 / 60 / 60);
    const minutes = Math.floor((diff / 1000 / 60) % 60);
    return `${hours}小时 ${minutes}分钟`;
  }, [mailbox]);

  const refreshMessages = useCallback(async () => {
    if (!mailbox || !token) return;
    setLoading(true);
    setError(null);
    try {
      const next = await listMessages(mailbox.address, token);
      setMessages(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '刷新失败');
    } finally {
      setLoading(false);
    }
  }, [mailbox, token]);

  useEffect(() => {
    void getConfig()
      .then((next) => {
        setConfig(next);
        setDomain(next.emailDomains[0] || '');
        setTtlHours(next.defaultTtlHours);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '配置加载失败'));
  }, []);

  useEffect(() => {
    if (!stored) return;

    void getMailbox(stored.mailbox.address, stored.token)
      .then((mailbox) => {
        const next = { mailbox, token: stored.token };
        setStored(next);
        writeStoredMailbox(next);
      })
      .catch(() => {
        setStored(null);
        writeStoredMailbox(null);
      });
  }, []);

  useEffect(() => {
    void refreshMessages();
    const timer = window.setInterval(() => void refreshMessages(), 10000);
    return () => window.clearInterval(timer);
  }, [refreshMessages]);

  async function handleCreateMailbox(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !domain) return;

    setLoading(true);
    setError(null);
    setSelected(null);
    setAttachments([]);

    try {
      const next = await createMailbox({
        address: localPart || undefined,
        domain,
        ttlHours
      });
      setStored(next);
      writeStoredMailbox(next);
      setMessages([]);
      setLocalPart('');
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectMessage(message: MessageListItem) {
    if (!token) return;

    setMessageLoading(true);
    setError(null);
    try {
      const [detail, files] = await Promise.all([
        getMessage(message.id, token),
        listAttachments(message.id, token)
      ]);
      setSelected(detail);
      setAttachments(files);
      setMessages((current) =>
        current.map((item) => (item.id === message.id ? { ...item, isRead: true } : item))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '邮件加载失败');
    } finally {
      setMessageLoading(false);
    }
  }

  async function handleDeleteMessage(id: string) {
    if (!token) return;

    await deleteMessage(id, token);
    setMessages((current) => current.filter((item) => item.id !== id));
    if (selected?.id === id) {
      setSelected(null);
      setAttachments([]);
    }
  }

  async function handleDeleteMailbox() {
    if (!mailbox || !token) return;

    await deleteMailbox(mailbox.address, token);
    setStored(null);
    writeStoredMailbox(null);
    setMessages([]);
    setSelected(null);
    setAttachments([]);
  }

  async function copyAddress() {
    if (!mailbox) return;
    await navigator.clipboard.writeText(mailbox.address);
  }

  return (
    <main className="shell">
      <section className="toolbar">
        <div>
          <div className="brand">
            <ShieldCheck size={22} />
            <span>Selfhost Mailbox</span>
          </div>
          {mailbox ? <p className="muted">{mailbox.address}</p> : <p className="muted">SMTP 自托管临时邮箱</p>}
        </div>
        <div className="toolbar-actions">
          <button className="icon-button" onClick={refreshMessages} disabled={!mailbox || loading} title="刷新">
            <RefreshCw size={18} />
          </button>
          <button className="icon-button danger" onClick={handleDeleteMailbox} disabled={!mailbox} title="删除邮箱">
            <Trash2 size={18} />
          </button>
        </div>
      </section>

      {error ? <div className="notice">{error}</div> : null}

      <section className="layout">
        <aside className="sidebar">
          <form className="panel" onSubmit={handleCreateMailbox}>
            <div className="panel-title">
              <Inbox size={18} />
              <h2>邮箱</h2>
            </div>
            <label>
              <span>地址</span>
              <div className="address-row">
                <input
                  value={localPart}
                  onChange={(event) => setLocalPart(event.target.value)}
                  placeholder="随机"
                  autoComplete="off"
                />
                <select value={domain} onChange={(event) => setDomain(event.target.value)}>
                  {(config?.emailDomains || []).map((item) => (
                    <option key={item} value={item}>
                      @{item}
                    </option>
                  ))}
                </select>
              </div>
            </label>
            <label>
              <span>有效期</span>
              <input
                type="number"
                min={1}
                max={config?.maxTtlHours || 168}
                value={ttlHours}
                onChange={(event) => setTtlHours(Number(event.target.value))}
              />
            </label>
            <button className="primary" disabled={loading || !config}>
              <Plus size={18} />
              创建邮箱
            </button>
          </form>

          {mailbox ? (
            <div className="panel current-mailbox">
              <span className="eyebrow">当前邮箱</span>
              <strong>{mailbox.address}</strong>
              <div className="meta-line">
                <span>{expiresLabel}</span>
                <span>{formatTime(mailbox.expiresAt)}</span>
              </div>
              <button className="secondary" onClick={copyAddress}>
                <Copy size={17} />
                复制地址
              </button>
            </div>
          ) : null}
        </aside>

        <section className="message-list">
          <div className="section-head">
            <h1>收件箱</h1>
            <span>{loading ? '刷新中' : `${messages.length} 封邮件`}</span>
          </div>
          <div className="messages">
            {messages.map((message) => (
              <button
                key={message.id}
                className={`message-row ${selected?.id === message.id ? 'active' : ''}`}
                onClick={() => void handleSelectMessage(message)}
              >
                <span className={`read-dot ${message.isRead ? 'read' : ''}`} />
                <span className="message-main">
                  <strong>{message.fromName || message.fromAddress || '未知发件人'}</strong>
                  <span>{message.subject || '无主题'}</span>
                  <small>{message.preview || '没有文本内容'}</small>
                </span>
                <span className="message-side">
                  <time>{formatTime(message.receivedAt)}</time>
                  {message.hasAttachments ? <Mail size={15} /> : null}
                </span>
              </button>
            ))}

            {!mailbox ? <div className="empty">先创建一个邮箱</div> : null}
            {mailbox && messages.length === 0 && !loading ? <div className="empty">暂无邮件</div> : null}
          </div>
        </section>

        <section className="detail">
          <div className="section-head">
            <h1>邮件内容</h1>
            {selected ? (
              <button className="icon-button danger" onClick={() => void handleDeleteMessage(selected.id)} title="删除邮件">
                <Trash2 size={17} />
              </button>
            ) : null}
          </div>

          {messageLoading ? <div className="empty">加载中</div> : null}

          {!messageLoading && selected ? (
            <article className="mail-view">
              <header>
                <h2>{selected.subject || '无主题'}</h2>
                <div className="mail-meta">
                  <span>{selected.fromName || selected.fromAddress}</span>
                  <span>{formatTime(selected.receivedAt)}</span>
                </div>
              </header>

              {attachments.length > 0 ? (
                <div className="attachments">
                  {attachments.map((attachment) => (
                    <button
                      key={attachment.id}
                      className="attachment"
                      onClick={() => void downloadAttachment(attachment, token)}
                    >
                      <Download size={16} />
                      <span>{attachment.filename}</span>
                      <small>{formatBytes(attachment.sizeBytes)}</small>
                    </button>
                  ))}
                </div>
              ) : null}

              {selected.htmlBody ? (
                <iframe title="邮件 HTML 内容" sandbox="" srcDoc={selected.htmlBody} />
              ) : (
                <pre>{selected.textBody || '没有正文'}</pre>
              )}
            </article>
          ) : null}

          {!messageLoading && !selected ? <div className="empty">选择一封邮件查看</div> : null}
        </section>
      </section>
    </main>
  );
}
