import {
  Archive,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  Inbox,
  KeyRound,
  Link2,
  Mail,
  MailPlus,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AppConfig,
  type AttachmentRecord,
  type Mailbox,
  type MessageListItem,
  type MessageRecord,
  type ShareInfo,
  createMailbox,
  createMailboxShare,
  deleteMailbox,
  deleteMessage,
  disableMailboxShare,
  downloadAdminAttachment,
  downloadAttachment,
  downloadSharedAttachment,
  getAdminMessage,
  getConfig,
  getMailbox,
  getMessage,
  getSharedMailbox,
  getSharedMessage,
  listAdminAttachments,
  listAdminMailboxes,
  listAdminMessages,
  listAttachments,
  listMessages,
  listSharedAttachments,
  listSharedMessages,
  updateMailboxRetention
} from './api';

interface StoredMailbox {
  mailbox: Mailbox;
  token: string;
  share?: ShareInfo;
}

interface VisibleMailbox {
  mailbox: Mailbox;
  token?: string;
  share?: ShareInfo;
  source: 'owned' | 'admin';
}

interface MessagePaneProps {
  messages: MessageListItem[];
  selectedId?: string;
  loading: boolean;
  emptyLabel: string;
  onSelect: (message: MessageListItem) => void;
}

interface ReaderProps {
  selected: MessageRecord | null;
  attachments: AttachmentRecord[];
  loading: boolean;
  canDelete?: boolean;
  onDelete?: (id: string) => void;
  onDownload: (attachment: AttachmentRecord) => void;
}

const MAILBOXES_STORAGE_KEY = 'selfhost-mailbox.mailboxes.v1';
const ACTIVE_STORAGE_KEY = 'selfhost-mailbox.active.v1';
const LEGACY_STORAGE_KEY = 'selfhost-mailbox.current';
const ADMIN_TOKEN_STORAGE_KEY = 'selfhost-mailbox.admin-token.v1';

function isMailboxActive(mailbox: Mailbox): boolean {
  return !mailbox.expiresAt || new Date(mailbox.expiresAt).getTime() > Date.now();
}

function readStoredMailboxes(): StoredMailbox[] {
  const raw = localStorage.getItem(MAILBOXES_STORAGE_KEY);
  const parsed = parseMailboxList(raw);
  if (parsed.length > 0) return parsed;

  const legacy = parseStoredMailbox(localStorage.getItem(LEGACY_STORAGE_KEY));
  return legacy ? [legacy] : [];
}

function parseMailboxList(raw: string | null): StoredMailbox[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const stored = parseStoredMailbox(JSON.stringify(item));
      return stored ? [stored] : [];
    });
  } catch {
    return [];
  }
}

function parseStoredMailbox(raw: string | null): StoredMailbox | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredMailbox;
    if (!parsed.mailbox?.address || !parsed.token) return null;
    if (!isMailboxActive(parsed.mailbox)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredMailboxes(value: StoredMailbox[]): void {
  localStorage.setItem(MAILBOXES_STORAGE_KEY, JSON.stringify(value));
}

function writeActiveAddress(value: string): void {
  if (!value) {
    localStorage.removeItem(ACTIVE_STORAGE_KEY);
    return;
  }

  localStorage.setItem(ACTIVE_STORAGE_KEY, value);
}

function readAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '';
}

function writeAdminToken(value: string): void {
  if (!value) {
    localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    return;
  }

  localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, value);
}

function initialActiveAddress(mailboxes: StoredMailbox[]): string {
  const saved = localStorage.getItem(ACTIVE_STORAGE_KEY);
  if (saved && mailboxes.some((item) => item.mailbox.address === saved)) return saved;
  return mailboxes[0]?.mailbox.address || '';
}

function upsertMailbox(mailboxes: StoredMailbox[], next: StoredMailbox): StoredMailbox[] {
  const existing = mailboxes.findIndex((item) => item.mailbox.address === next.mailbox.address);
  if (existing === -1) return [next, ...mailboxes];

  return mailboxes.map((item, index) => (index === existing ? { ...item, ...next } : item));
}

function currentShareUrl(token: string): string {
  return `${window.location.origin.replace(/\/+$/, '')}/share/${encodeURIComponent(token)}`;
}

function normalizeShare(share: ShareInfo): ShareInfo {
  return {
    token: share.token,
    url: currentShareUrl(share.token)
  };
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

function mailboxLifeLabel(mailbox: Mailbox | null): string {
  if (!mailbox) return '';
  if (!mailbox.expiresAt) return '长期保存';

  const diff = new Date(mailbox.expiresAt).getTime() - Date.now();
  if (diff <= 0) return '已过期';
  const hours = Math.floor(diff / 1000 / 60 / 60);
  const minutes = Math.floor((diff / 1000 / 60) % 60);
  return `${hours}小时 ${minutes}分钟`;
}

function shareTokenFromPath(): string | null {
  const match = window.location.pathname.match(/^\/share\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function copyToClipboard(value: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0 auto auto 0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('copy command failed');
  } finally {
    textarea.remove();
  }
}

export default function App() {
  const shareToken = useMemo(() => shareTokenFromPath(), []);
  if (shareToken) return <SharedInbox shareToken={shareToken} />;

  return <MailboxDashboard />;
}

function MailboxDashboard() {
  const initialMailboxes = useMemo(() => readStoredMailboxes(), []);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [storedMailboxes, setStoredMailboxes] = useState<StoredMailbox[]>(initialMailboxes);
  const [activeAddress, setActiveAddress] = useState(() => initialActiveAddress(initialMailboxes));
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState('');
  const [ttlHours, setTtlHours] = useState(24);
  const [permanent, setPermanent] = useState(true);
  const [adminToken, setAdminToken] = useState(() => readAdminToken());
  const [adminInput, setAdminInput] = useState(() => readAdminToken());
  const [adminMailboxes, setAdminMailboxes] = useState<Mailbox[]>([]);
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [selected, setSelected] = useState<MessageRecord | null>(null);
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const visibleMailboxes = useMemo<VisibleMailbox[]>(() => {
    const owned = storedMailboxes.map((item) => ({ ...item, source: 'owned' as const }));
    const ownedAddresses = new Set(owned.map((item) => item.mailbox.address));
    const adminOnly = adminMailboxes
      .filter((mailbox) => !ownedAddresses.has(mailbox.address))
      .map((mailbox) => ({ mailbox, source: 'admin' as const }));

    return [...owned, ...adminOnly];
  }, [adminMailboxes, storedMailboxes]);

  const activeStored = useMemo(
    () => storedMailboxes.find((item) => item.mailbox.address === activeAddress) || null,
    [activeAddress, storedMailboxes]
  );
  const activeVisible = useMemo(
    () => visibleMailboxes.find((item) => item.mailbox.address === activeAddress) || visibleMailboxes[0] || null,
    [activeAddress, visibleMailboxes]
  );
  const mailbox = activeVisible?.mailbox || null;
  const token = activeStored?.token || '';
  const activeShare = activeStored?.share ? normalizeShare(activeStored.share) : null;

  const filteredMessages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((message) =>
      [message.fromAddress, message.fromName, message.subject, message.preview]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [messages, query]);

  const unreadCount = useMemo(() => messages.filter((message) => !message.isRead).length, [messages]);

  const commitMailboxes = useCallback(
    (next: StoredMailbox[], preferredAddress = activeAddress) => {
      const active = next.some((item) => item.mailbox.address === preferredAddress)
        ? preferredAddress
        : next[0]?.mailbox.address || '';

      setStoredMailboxes(next);
      setActiveAddress(active);
      writeStoredMailboxes(next);
      writeActiveAddress(active);
    },
    [activeAddress]
  );

  const showNotice = useCallback((type: 'error' | 'success', text: string) => {
    setNotice({ type, text });
    if (type === 'success') {
      window.setTimeout(() => setNotice(null), 2400);
    }
  }, []);

  const copyText = useCallback(
    async (value: string, label: string, showFailure = true): Promise<boolean> => {
      try {
        await copyToClipboard(value);
        showNotice('success', `${label}已复制`);
        return true;
      } catch {
        if (showFailure) showNotice('error', '复制失败，请手动复制');
        return false;
      }
    },
    [showNotice]
  );

  const loadAdminMailboxList = useCallback(
    async (tokenValue = adminInput, announce = true) => {
      const nextToken = tokenValue.trim();
      if (!nextToken) {
        showNotice('error', '请输入管理密钥');
        return;
      }

      setAdminLoading(true);
      setNotice(null);
      try {
        const next = await listAdminMailboxes(nextToken);
        setAdminToken(nextToken);
        setAdminInput(nextToken);
        setAdminMailboxes(next);
        writeAdminToken(nextToken);

        const localAddresses = new Set(storedMailboxes.map((item) => item.mailbox.address));
        const hasActive =
          !!activeAddress &&
          (localAddresses.has(activeAddress) || next.some((item) => item.address === activeAddress));
        if (!hasActive && next[0]) {
          setActiveAddress(next[0].address);
          writeActiveAddress(next[0].address);
        }

        if (announce) showNotice('success', `已加载 ${next.length} 个服务器邮箱`);
      } catch (err) {
        showNotice('error', err instanceof Error ? err.message : '服务器邮箱加载失败');
      } finally {
        setAdminLoading(false);
      }
    },
    [activeAddress, adminInput, showNotice, storedMailboxes]
  );

  function handleDisconnectAdmin() {
    setAdminToken('');
    setAdminInput('');
    setAdminMailboxes([]);
    writeAdminToken('');
    showNotice('success', '已退出服务器同步');
  }

  const refreshMessages = useCallback(async () => {
    if (!mailbox) {
      setMessages([]);
      return;
    }

    setLoading(true);
    setNotice(null);
    try {
      const next = token
        ? await listMessages(mailbox.address, token)
        : await listAdminMessages(mailbox.address, adminToken);
      setMessages(next);
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '刷新失败');
    } finally {
      setLoading(false);
    }
  }, [adminToken, mailbox, showNotice, token]);

  useEffect(() => {
    void getConfig()
      .then((next) => {
        setConfig(next);
        setDomain(next.emailDomains[0] || '');
        setTtlHours(next.defaultTtlHours);
      })
      .catch((err) => showNotice('error', err instanceof Error ? err.message : '配置加载失败'));
  }, [showNotice]);

  useEffect(() => {
    if (!config?.adminEnabled || !adminToken) return;
    void loadAdminMailboxList(adminToken, false);
  }, [config?.adminEnabled]);

  useEffect(() => {
    if (storedMailboxes.length === 0) return;

    let cancelled = false;
    void Promise.allSettled(
      storedMailboxes.map(async (item) => ({
        ...item,
        mailbox: await getMailbox(item.mailbox.address, item.token)
      }))
    ).then((results) => {
      if (cancelled) return;
      const refreshed = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      commitMailboxes(refreshed, activeAddress);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setSelected(null);
    setAttachments([]);
    setMessages([]);
    void refreshMessages();
    const timer = window.setInterval(() => void refreshMessages(), 10000);
    return () => window.clearInterval(timer);
  }, [refreshMessages]);

  async function handleCreateMailbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !domain) return;

    setLoading(true);
    setNotice(null);
    setSelected(null);
    setAttachments([]);

    try {
      const next = await createMailbox({
        address: localPart.trim() || undefined,
        domain,
        ttlHours: permanent ? null : ttlHours,
        permanent
      });
      const stored: StoredMailbox = { mailbox: next.mailbox, token: next.token };
      commitMailboxes(upsertMailbox(storedMailboxes, stored), next.mailbox.address);
      setMessages([]);
      setLocalPart('');
      showNotice('success', '邮箱已创建');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleSelectMessage(message: MessageListItem) {
    if (!token && !adminToken) return;

    setMessageLoading(true);
    setNotice(null);
    try {
      const [detail, files] = token
        ? await Promise.all([getMessage(message.id, token), listAttachments(message.id, token)])
        : await Promise.all([
            getAdminMessage(message.id, adminToken),
            listAdminAttachments(message.id, adminToken)
          ]);
      setSelected(detail);
      setAttachments(files);
      if (token) {
        setMessages((current) =>
          current.map((item) => (item.id === message.id ? { ...item, isRead: true } : item))
        );
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '邮件加载失败');
    } finally {
      setMessageLoading(false);
    }
  }

  async function handleDeleteMessage(id: string) {
    if (!token) return;

    try {
      await deleteMessage(id, token);
      setMessages((current) => current.filter((item) => item.id !== id));
      if (selected?.id === id) {
        setSelected(null);
        setAttachments([]);
      }
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '删除失败');
    }
  }

  async function handleDeleteMailbox() {
    if (!mailbox || !token) return;

    try {
      await deleteMailbox(mailbox.address, token);
      const next = storedMailboxes.filter((item) => item.mailbox.address !== mailbox.address);
      commitMailboxes(next);
      setMessages([]);
      setSelected(null);
      setAttachments([]);
      showNotice('success', '邮箱已删除');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '删除失败');
    }
  }

  async function handleCreateShare() {
    if (!mailbox || !token) return;

    setShareLoading(true);
    setNotice(null);
    try {
      const result = await createMailboxShare(mailbox.address, token);
      const nextStored: StoredMailbox = {
        mailbox: result.mailbox,
        token,
        share: normalizeShare(result.share)
      };
      commitMailboxes(upsertMailbox(storedMailboxes, nextStored), result.mailbox.address);
      const copied = await copyText(currentShareUrl(result.share.token), '分享链接', false);
      if (!copied) showNotice('success', '分享链接已生成，可点击复制按钮复制');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '分享失败');
    } finally {
      setShareLoading(false);
    }
  }

  async function handleDisableShare() {
    if (!mailbox || !token) return;

    setShareLoading(true);
    setNotice(null);
    try {
      const nextMailbox = await disableMailboxShare(mailbox.address, token);
      const nextStored: StoredMailbox = { mailbox: nextMailbox, token };
      commitMailboxes(upsertMailbox(storedMailboxes, nextStored), nextMailbox.address);
      showNotice('success', '分享已关闭');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '关闭分享失败');
    } finally {
      setShareLoading(false);
    }
  }

  async function handleKeepMailbox() {
    if (!mailbox || !token || !activeStored) return;

    setShareLoading(true);
    setNotice(null);
    try {
      const nextMailbox = await updateMailboxRetention(mailbox.address, token, { permanent: true });
      commitMailboxes(
        upsertMailbox(storedMailboxes, {
          ...activeStored,
          mailbox: nextMailbox
        }),
        nextMailbox.address
      );
      showNotice('success', '邮箱已设为长期保存');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '更新失败');
    } finally {
      setShareLoading(false);
    }
  }

  function handleSwitchMailbox(address: string) {
    setActiveAddress(address);
    writeActiveAddress(address);
  }

  return (
    <main className="app-shell">
      <Topbar
        mailbox={mailbox}
        messageCount={messages.length}
        unreadCount={unreadCount}
        loading={loading}
        onRefresh={refreshMessages}
        onDelete={token ? handleDeleteMailbox : undefined}
      />

      {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}

      <section className="workspace">
        <aside className="sidebar">
          <form className="panel compose-panel" onSubmit={handleCreateMailbox}>
            <div className="panel-title">
              <MailPlus size={18} />
              <h2>新建地址</h2>
            </div>

            <label>
              <span>邮箱前缀</span>
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

            <div className="segmented" aria-label="保存时间">
              <button type="button" className={permanent ? 'active' : ''} onClick={() => setPermanent(true)}>
                <Archive size={15} />
                长期
              </button>
              <button type="button" className={!permanent ? 'active' : ''} onClick={() => setPermanent(false)}>
                <Clock3 size={15} />
                限时
              </button>
            </div>

            {!permanent ? (
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
            ) : null}

            <button className="primary" disabled={loading || !config}>
              <Plus size={18} />
              创建邮箱
            </button>
          </form>

          {config?.adminEnabled ? (
            <section className="panel admin-panel">
              <div className="panel-title">
                <KeyRound size={18} />
                <h2>服务器同步</h2>
              </div>
              <label>
                <span>管理密钥</span>
                <input
                  type="password"
                  value={adminInput}
                  onChange={(event) => setAdminInput(event.target.value)}
                  placeholder="ADMIN_TOKEN"
                  autoComplete="off"
                />
              </label>
              <div className="admin-actions">
                <button
                  className="secondary"
                  type="button"
                  onClick={() => void loadAdminMailboxList(adminInput)}
                  disabled={adminLoading}
                >
                  <RefreshCw size={16} />
                  {adminToken ? '刷新列表' : '加载邮箱'}
                </button>
                {adminToken ? (
                  <button className="secondary" type="button" onClick={handleDisconnectAdmin}>
                    退出
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          <section className="panel mailbox-panel">
            <div className="panel-title">
              <Users size={18} />
              <h2>地址管理</h2>
              <span className="count-pill">{visibleMailboxes.length}</span>
            </div>

            <div className="mailbox-stack">
              {visibleMailboxes.map((item) => (
                <button
                  key={item.mailbox.address}
                  className={`mailbox-card ${item.mailbox.address === mailbox?.address ? 'active' : ''}`}
                  onClick={() => handleSwitchMailbox(item.mailbox.address)}
                  type="button"
                >
                  <span className="mailbox-icon">
                    <Inbox size={17} />
                  </span>
                  <span className="mailbox-text">
                    <strong>{item.mailbox.address}</strong>
                    <small>{item.source === 'admin' ? `服务器同步 · ${mailboxLifeLabel(item.mailbox)}` : mailboxLifeLabel(item.mailbox)}</small>
                  </span>
                  {item.share ? <Link2 size={15} /> : null}
                </button>
              ))}

              {visibleMailboxes.length === 0 ? <div className="empty compact">暂无邮箱</div> : null}
            </div>
          </section>

          {mailbox ? (
            <section className="panel share-panel">
              <div className="panel-title">
                <Link2 size={18} />
                <h2>分享</h2>
              </div>
              <div className="share-address">
                <strong>{mailbox.address}</strong>
                <span>{mailboxLifeLabel(mailbox)}</span>
              </div>
              <div className="share-actions">
                <button className="secondary" type="button" onClick={() => void copyText(mailbox.address, '邮箱地址')}>
                  <Copy size={16} />
                  复制地址
                </button>
                <button className="secondary" type="button" onClick={handleCreateShare} disabled={shareLoading || !token}>
                  <Link2 size={16} />
                  {activeShare ? '更新链接' : '生成链接'}
                </button>
              </div>

              {!token ? <p className="panel-hint">这是服务器同步邮箱，可查看历史邮件；生成分享和删除需要本浏览器保存过该邮箱 token。</p> : null}

              {mailbox.expiresAt && token ? (
                <button className="secondary stretch" type="button" onClick={handleKeepMailbox} disabled={shareLoading}>
                  <Archive size={16} />
                  设为长期
                </button>
              ) : null}

              {activeShare ? (
                <div className="share-link-row">
                  <input value={activeShare.url} readOnly aria-label="分享链接" />
                  <button
                    className="icon-button"
                    type="button"
                    title="复制分享链接"
                    onClick={() => void copyText(activeShare.url, '分享链接')}
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    title="打开分享链接"
                    onClick={() => window.open(activeShare.url, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink size={16} />
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    title="关闭分享"
                    onClick={handleDisableShare}
                    disabled={shareLoading}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ) : null}
            </section>
          ) : null}
        </aside>

        <section className="inbox-pane">
          <div className="pane-head">
            <div>
              <h1>收件箱</h1>
              <span>{loading ? '刷新中' : `${filteredMessages.length} 封邮件`}</span>
            </div>
            <label className="search-box">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
            </label>
          </div>
          <MessagePane
            messages={filteredMessages}
            selectedId={selected?.id}
            loading={loading}
            emptyLabel={mailbox ? '暂无邮件' : '先创建或选择一个邮箱'}
            onSelect={(message) => void handleSelectMessage(message)}
          />
        </section>

        <Reader
          selected={selected}
          attachments={attachments}
          loading={messageLoading}
          onDelete={(id) => void handleDeleteMessage(id)}
          canDelete={Boolean(token)}
          onDownload={(attachment) =>
            void (token ? downloadAttachment(attachment, token) : downloadAdminAttachment(attachment, adminToken))
          }
        />
      </section>
    </main>
  );
}

function SharedInbox({ shareToken }: { shareToken: string }) {
  const [mailbox, setMailbox] = useState<Mailbox | null>(null);
  const [messages, setMessages] = useState<MessageListItem[]>([]);
  const [selected, setSelected] = useState<MessageRecord | null>(null);
  const [attachments, setAttachments] = useState<AttachmentRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [messageLoading, setMessageLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const filteredMessages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((message) =>
      [message.fromAddress, message.fromName, message.subject, message.preview]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [messages, query]);

  const refreshShared = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const [nextMailbox, nextMessages] = await Promise.all([
        getSharedMailbox(shareToken),
        listSharedMessages(shareToken)
      ]);
      setMailbox(nextMailbox);
      setMessages(nextMessages);
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '分享收件箱不可用' });
    } finally {
      setLoading(false);
    }
  }, [shareToken]);

  useEffect(() => {
    void refreshShared();
    const timer = window.setInterval(() => void refreshShared(), 10000);
    return () => window.clearInterval(timer);
  }, [refreshShared]);

  async function handleSelectMessage(message: MessageListItem) {
    setMessageLoading(true);
    setNotice(null);
    try {
      const [detail, files] = await Promise.all([
        getSharedMessage(shareToken, message.id),
        listSharedAttachments(shareToken, message.id)
      ]);
      setSelected(detail);
      setAttachments(files);
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : '邮件加载失败' });
    } finally {
      setMessageLoading(false);
    }
  }

  return (
    <main className="app-shell shared">
      <Topbar
        mailbox={mailbox}
        messageCount={messages.length}
        unreadCount={0}
        loading={loading}
        onRefresh={refreshShared}
        readonly
      />

      {notice ? <div className={`notice ${notice.type}`}>{notice.text}</div> : null}

      <section className="workspace shared-workspace">
        <section className="inbox-pane">
          <div className="pane-head">
            <div>
              <h1>共享收件箱</h1>
              <span>{loading ? '刷新中' : `${filteredMessages.length} 封邮件`}</span>
            </div>
            <label className="search-box">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索" />
            </label>
          </div>
          <MessagePane
            messages={filteredMessages}
            selectedId={selected?.id}
            loading={loading}
            emptyLabel={mailbox ? '暂无邮件' : '分享链接不可用'}
            onSelect={(message) => void handleSelectMessage(message)}
          />
        </section>

        <Reader
          selected={selected}
          attachments={attachments}
          loading={messageLoading}
          onDownload={(attachment) => void downloadSharedAttachment(shareToken, attachment)}
        />
      </section>
    </main>
  );
}

function Topbar({
  mailbox,
  messageCount,
  unreadCount,
  loading,
  readonly,
  onRefresh,
  onDelete
}: {
  mailbox: Mailbox | null;
  messageCount: number;
  unreadCount: number;
  loading: boolean;
  readonly?: boolean;
  onRefresh: () => void;
  onDelete?: () => void;
}) {
  return (
    <section className="topbar">
      <div>
        <div className="brand">
          <ShieldCheck size={22} />
          <span>Selfhost Mailbox</span>
        </div>
        <p className="muted">{mailbox ? mailbox.address : readonly ? '只读收件箱' : 'SMTP 自托管邮箱'}</p>
      </div>
      <div className="topbar-stats">
        <span>{mailbox ? mailboxLifeLabel(mailbox) : '未选择'}</span>
        <span>{messageCount} 封</span>
        {!readonly ? <span>{unreadCount} 未读</span> : null}
      </div>
      <div className="toolbar-actions">
        <button className="icon-button" onClick={onRefresh} disabled={!mailbox || loading} title="刷新">
          <RefreshCw size={18} />
        </button>
        {!readonly && onDelete ? (
          <button className="icon-button danger" onClick={onDelete} disabled={!mailbox} title="删除邮箱">
            <Trash2 size={18} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function MessagePane({ messages, selectedId, loading, emptyLabel, onSelect }: MessagePaneProps) {
  return (
    <div className="messages">
      {messages.map((message) => (
        <button
          key={message.id}
          className={`message-row ${selectedId === message.id ? 'active' : ''}`}
          onClick={() => onSelect(message)}
          type="button"
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

      {messages.length === 0 && !loading ? <div className="empty">{emptyLabel}</div> : null}
      {messages.length === 0 && loading ? <div className="empty">刷新中</div> : null}
    </div>
  );
}

function Reader({ selected, attachments, loading, canDelete, onDelete, onDownload }: ReaderProps) {
  return (
    <section className="reader-pane">
      <div className="pane-head">
        <div>
          <h1>邮件内容</h1>
          <span>{selected ? formatBytes(selected.sizeBytes) : '未选择'}</span>
        </div>
        {selected && canDelete && onDelete ? (
          <button className="icon-button danger" onClick={() => onDelete(selected.id)} title="删除邮件">
            <Trash2 size={17} />
          </button>
        ) : null}
      </div>

      {loading ? <div className="empty">加载中</div> : null}

      {!loading && selected ? (
        <article className="mail-view">
          <header>
            <h2>{selected.subject || '无主题'}</h2>
            <div className="mail-meta">
              <span>{selected.fromName || selected.fromAddress || '未知发件人'}</span>
              <span>{formatTime(selected.receivedAt)}</span>
            </div>
          </header>

          {attachments.length > 0 ? (
            <div className="attachments">
              {attachments.map((attachment) => (
                <button key={attachment.id} className="attachment" onClick={() => onDownload(attachment)}>
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

      {!loading && !selected ? <div className="empty reader-empty">选择一封邮件查看</div> : null}
    </section>
  );
}
