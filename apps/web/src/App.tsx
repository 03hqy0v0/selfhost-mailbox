import {
  ArrowLeft,
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Inbox,
  KeyRound,
  Link2,
  Mail,
  MailPlus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
  X
} from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  type AppConfig,
  type AttachmentRecord,
  type Mailbox,
  type MessageListItem,
  type MessageRecord,
  type ShareInfo,
  createMailbox,
  createMailboxShare,
  deleteAdminMailbox,
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
  updateAdminMailboxNote,
  updateMailboxNote,
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
const MAILBOX_PAGE_SIZE = 5;

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
    parsed.mailbox.note ||= '';
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

function mailboxDisplayName(mailbox: Mailbox): string {
  return mailbox.note?.trim() || mailbox.address;
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
  const path = window.location.pathname;
  if (path === '/docs' || path.startsWith('/docs/')) return <ApiDocs />;

  const shareToken = shareTokenFromPath();
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
  const [editingNoteAddress, setEditingNoteAddress] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [mailboxQuery, setMailboxQuery] = useState('');
  const [mailboxPage, setMailboxPage] = useState(1);
  const [notice, setNotice] = useState<{ type: 'error' | 'success'; text: string } | null>(null);

  const visibleMailboxes = useMemo<VisibleMailbox[]>(() => {
    const owned = storedMailboxes.map((item) => ({ ...item, source: 'owned' as const }));
    const ownedAddresses = new Set(owned.map((item) => item.mailbox.address));
    const adminOnly = adminMailboxes
      .filter((mailbox) => !ownedAddresses.has(mailbox.address))
      .map((mailbox) => ({ mailbox, source: 'admin' as const }));

    return [...owned, ...adminOnly];
  }, [adminMailboxes, storedMailboxes]);

  const filteredMailboxes = useMemo(() => {
    const needle = mailboxQuery.trim().toLowerCase();
    if (!needle) return visibleMailboxes;

    return visibleMailboxes.filter((item) =>
      [
        item.mailbox.note,
        item.mailbox.address,
        item.mailbox.localPart,
        item.mailbox.domain,
        mailboxLifeLabel(item.mailbox),
        item.source === 'admin' ? '服务器同步' : ''
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    );
  }, [mailboxQuery, visibleMailboxes]);

  const mailboxPageCount = Math.max(1, Math.ceil(filteredMailboxes.length / MAILBOX_PAGE_SIZE));
  const currentMailboxPage = Math.min(mailboxPage, mailboxPageCount);
  const pagedMailboxes = useMemo(() => {
    const start = (currentMailboxPage - 1) * MAILBOX_PAGE_SIZE;
    return filteredMailboxes.slice(start, start + MAILBOX_PAGE_SIZE);
  }, [currentMailboxPage, filteredMailboxes]);

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
    setMailboxPage(1);
  }, [mailboxQuery]);

  useEffect(() => {
    if (mailboxPage > mailboxPageCount) setMailboxPage(mailboxPageCount);
  }, [mailboxPage, mailboxPageCount]);

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
      setMailboxQuery('');
      setMailboxPage(1);
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

  async function handleDeleteMailboxItem(item: VisibleMailbox) {
    const label = item.mailbox.note ? `${item.mailbox.note} (${item.mailbox.address})` : item.mailbox.address;
    const confirmed = window.confirm(`确定删除 ${label} 吗？这个邮箱的所有邮件和附件都会一起删除。`);
    if (!confirmed) return;

    setLoading(true);
    setNotice(null);
    try {
      if (item.token) {
        await deleteMailbox(item.mailbox.address, item.token);
      } else {
        await deleteAdminMailbox(item.mailbox.address, adminToken);
      }

      const nextStored = storedMailboxes.filter((stored) => stored.mailbox.address !== item.mailbox.address);
      const nextAdmin = adminMailboxes.filter((adminMailbox) => adminMailbox.address !== item.mailbox.address);
      const nextAddress =
        activeAddress === item.mailbox.address
          ? nextStored[0]?.mailbox.address || nextAdmin[0]?.address || ''
          : activeAddress;

      commitMailboxes(nextStored, nextAddress);
      setAdminMailboxes(nextAdmin);
      if (nextAddress && !nextStored.some((stored) => stored.mailbox.address === nextAddress)) {
        setActiveAddress(nextAddress);
        writeActiveAddress(nextAddress);
      }

      if (activeAddress === item.mailbox.address) {
        setMessages([]);
        setSelected(null);
        setAttachments([]);
      }

      if (editingNoteAddress === item.mailbox.address) {
        handleCancelNoteEdit();
      }

      showNotice('success', '邮箱和对应邮件已删除');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '删除失败');
    } finally {
      setLoading(false);
    }
  }

  async function createAndStoreShare(): Promise<ShareInfo> {
    if (!mailbox || !token) throw new Error('当前邮箱不能生成分享链接');

    const result = await createMailboxShare(mailbox.address, token);
    const share = normalizeShare(result.share);
    const nextStored: StoredMailbox = {
      mailbox: result.mailbox,
      token,
      share
    };
    commitMailboxes(upsertMailbox(storedMailboxes, nextStored), result.mailbox.address);
    return share;
  }

  async function handleCreateShare() {
    if (!mailbox || !token) return;

    setShareLoading(true);
    setNotice(null);
    try {
      const share = await createAndStoreShare();
      const copied = await copyText(share.url, '分享链接', false);
      if (!copied) showNotice('success', '分享链接已生成，可点击复制按钮复制');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '分享失败');
    } finally {
      setShareLoading(false);
    }
  }

  async function handleCopyAddressAndShare() {
    if (!mailbox || !token) return;

    setShareLoading(true);
    setNotice(null);
    try {
      const share = activeShare || (await createAndStoreShare());
      const payload = `${mailbox.address}----${share.url}`;
      await copyToClipboard(payload);
      showNotice('success', '邮箱和接码链接已复制');
    } catch (err) {
      showNotice(
        'error',
        err instanceof Error ? `复制失败：${err.message}` : '复制失败，请手动复制'
      );
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

  function handleStartNoteEdit(item: VisibleMailbox) {
    setEditingNoteAddress(item.mailbox.address);
    setNoteDraft(item.mailbox.note || '');
  }

  function handleCancelNoteEdit() {
    setEditingNoteAddress('');
    setNoteDraft('');
  }

  async function handleSaveNote(item: VisibleMailbox) {
    const note = noteDraft.trim();
    if (note.length > 80) {
      showNotice('error', '备注最多 80 个字符');
      return;
    }

    setNoteSaving(true);
    setNotice(null);
    try {
      const nextMailbox = item.token
        ? await updateMailboxNote(item.mailbox.address, item.token, note)
        : await updateAdminMailboxNote(item.mailbox.address, adminToken, note);

      if (item.token) {
        const nextStored: StoredMailbox = {
          mailbox: nextMailbox,
          token: item.token,
          share: item.share
        };
        commitMailboxes(upsertMailbox(storedMailboxes, nextStored), nextMailbox.address);
      }

      setAdminMailboxes((current) =>
        current.map((mailbox) => (mailbox.address === nextMailbox.address ? nextMailbox : mailbox))
      );
      setEditingNoteAddress('');
      setNoteDraft('');
      showNotice('success', note ? '备注已保存' : '备注已清空');
    } catch (err) {
      showNotice('error', err instanceof Error ? err.message : '备注保存失败');
    } finally {
      setNoteSaving(false);
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
        docsLink
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
              <span className="count-pill">
                {filteredMailboxes.length}/{visibleMailboxes.length}
              </span>
            </div>

            <label className="mailbox-search">
              <Search size={16} />
              <input
                value={mailboxQuery}
                onChange={(event) => setMailboxQuery(event.target.value)}
                placeholder="搜索邮箱或备注"
              />
              {mailboxQuery ? (
                <button
                  className="icon-button clear-search"
                  type="button"
                  title="清空搜索"
                  onClick={() => setMailboxQuery('')}
                >
                  <X size={15} />
                </button>
              ) : null}
            </label>

            <div className="mailbox-stack">
              {pagedMailboxes.map((item) => {
                const isEditing = editingNoteAddress === item.mailbox.address;
                return (
                  <div
                    key={item.mailbox.address}
                    className={`mailbox-card ${item.mailbox.address === mailbox?.address ? 'active' : ''} ${
                      isEditing ? 'editing' : ''
                    }`}
                  >
                    {isEditing ? (
                      <>
                        <span className="mailbox-icon">
                          <Inbox size={17} />
                        </span>
                        <label className="note-editor">
                          <span>备注</span>
                          <input
                            value={noteDraft}
                            onChange={(event) => setNoteDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void handleSaveNote(item);
                              if (event.key === 'Escape') handleCancelNoteEdit();
                            }}
                            maxLength={80}
                            placeholder="例如：给客户 A 注册"
                            autoFocus
                          />
                        </label>
                        <span className="note-actions">
                          <button
                            className="icon-button"
                            type="button"
                            title="保存备注"
                            onClick={() => void handleSaveNote(item)}
                            disabled={noteSaving}
                          >
                            <Check size={16} />
                          </button>
                          <button
                            className="icon-button"
                            type="button"
                            title="取消"
                            onClick={handleCancelNoteEdit}
                            disabled={noteSaving}
                          >
                            <X size={16} />
                          </button>
                        </span>
                      </>
                    ) : (
                      <>
                        <button
                          className="mailbox-open"
                          onClick={() => handleSwitchMailbox(item.mailbox.address)}
                          type="button"
                        >
                          <span className="mailbox-icon">
                            <Inbox size={17} />
                          </span>
                          <span className="mailbox-text">
                            <strong>{mailboxDisplayName(item.mailbox)}</strong>
                            <small>{item.mailbox.note ? item.mailbox.address : mailboxLifeLabel(item.mailbox)}</small>
                            {item.mailbox.note ? (
                              <small>
                                {item.source === 'admin'
                                  ? `服务器同步 · ${mailboxLifeLabel(item.mailbox)}`
                                  : mailboxLifeLabel(item.mailbox)}
                              </small>
                            ) : item.source === 'admin' ? (
                              <small>服务器同步</small>
                            ) : null}
                          </span>
                          {item.share ? <Link2 size={15} /> : null}
                        </button>
                        <span className="mailbox-tools">
                          <button
                            className="icon-button note-button"
                            type="button"
                            title="编辑备注"
                            onClick={() => handleStartNoteEdit(item)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-button note-button danger"
                            type="button"
                            title="删除邮箱和邮件"
                            onClick={() => void handleDeleteMailboxItem(item)}
                            disabled={loading}
                          >
                            <Trash2 size={15} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                );
              })}

              {visibleMailboxes.length === 0 ? <div className="empty compact">暂无邮箱</div> : null}
              {visibleMailboxes.length > 0 && filteredMailboxes.length === 0 ? (
                <div className="empty compact">没有匹配的邮箱</div>
              ) : null}
            </div>

            <div className="mailbox-pagination">
              <button
                className="icon-button"
                type="button"
                title="上一页"
                onClick={() => setMailboxPage((page) => Math.max(1, page - 1))}
                disabled={currentMailboxPage <= 1}
              >
                <ChevronLeft size={17} />
              </button>
              <span>
                第 {currentMailboxPage} / {mailboxPageCount} 页
              </span>
              <button
                className="icon-button"
                type="button"
                title="下一页"
                onClick={() => setMailboxPage((page) => Math.min(mailboxPageCount, page + 1))}
                disabled={currentMailboxPage >= mailboxPageCount}
              >
                <ChevronRight size={17} />
              </button>
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

              <button
                className="secondary stretch"
                type="button"
                onClick={handleCopyAddressAndShare}
                disabled={shareLoading || !token}
              >
                <Copy size={16} />
                复制邮箱和接码链接
              </button>

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
  docsLink,
  onRefresh,
  onDelete
}: {
  mailbox: Mailbox | null;
  messageCount: number;
  unreadCount: number;
  loading: boolean;
  readonly?: boolean;
  docsLink?: boolean;
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
        {docsLink ? (
          <a className="icon-button" href="/docs" title="API 文档">
            <Code2 size={18} />
          </a>
        ) : null}
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

function resolveDocsBase(config: AppConfig | null): string {
  const configured = (config?.publicBaseUrl || '').replace(/\/+$/, '');
  if (/^https?:\/\//.test(configured) && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(configured)) {
    return configured;
  }

  return window.location.origin.replace(/\/+$/, '');
}

function DocCode({ code, label }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await copyToClipboard(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore copy failures in docs */
    }
  }

  return (
    <div className="doc-code">
      <div className="doc-code-bar">
        <span className="doc-code-label">{label || ''}</span>
        <button className="doc-copy" type="button" onClick={handleCopy}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{code}</pre>
    </div>
  );
}

function DocEndpoint({ method, path, children }: { method: string; path: string; children: ReactNode }) {
  return (
    <div className="doc-endpoint">
      <div className="doc-endpoint-head">
        <span className={`doc-method ${method.toLowerCase()}`}>{method}</span>
        <code className="doc-path">{path}</code>
      </div>
      <div className="doc-endpoint-body">{children}</div>
    </div>
  );
}

function ApiDocs() {
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    void getConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const base = resolveDocsBase(config);
  const sampleDomain = config?.emailDomains[0] || 'example.com';
  const sampleLocal = 'k7f2x9q1';
  const sampleAddress = `${sampleLocal}@${sampleDomain}`;
  const ttlNote = config ? `${config.defaultTtlHours} 小时（最长 ${config.maxTtlHours} 小时）` : '配置的默认有效期';

  const createRandomReq = `curl -X POST ${base}/api/v1/mailboxes \\
  -H "Authorization: Bearer $API_TOKEN"`;

  const createRandomRes = `{
  "success": true,
  "address": "${sampleAddress}",
  "localPart": "${sampleLocal}",
  "domain": "${sampleDomain}",
  "createdAt": "2026-05-27T08:00:00.000Z",
  "expiresAt": "2026-05-28T08:00:00.000Z",
  "token": "Yx3k...  // 该邮箱独立 token，用 API_TOKEN 调用时可忽略"
}`;

  const createCustomReq = `curl -X POST ${base}/api/v1/mailboxes \\
  -H "Authorization: Bearer $API_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "login-test", "domain": "${sampleDomain}", "permanent": true}'`;

  const listReq = `curl ${base}/api/v1/mailboxes/${sampleAddress}/messages \\
  -H "Authorization: Bearer $API_TOKEN"`;

  const listRes = `{
  "success": true,
  "address": "${sampleAddress}",
  "count": 1,
  "messages": [
    {
      "id": "8f1c-...",
      "from": "no-reply@github.com",
      "fromName": "GitHub",
      "to": "${sampleAddress}",
      "subject": "你的验证码是 123456",
      "text": "你的验证码是 123456，10 分钟内有效。",
      "html": "<p>你的验证码是 <b>123456</b></p>",
      "receivedAt": "2026-05-27T08:01:12.000Z",
      "isRead": false,
      "sizeBytes": 2048,
      "hasAttachments": false
    }
  ]
}`;

  const latestReq = `curl "${base}/api/v1/mailboxes/${sampleAddress}/latest?unread=true" \\
  -H "Authorization: Bearer $API_TOKEN"`;

  const latestRes = `{
  "success": true,
  "message": {
    "id": "8f1c-...",
    "from": "no-reply@github.com",
    "subject": "你的验证码是 123456",
    "text": "你的验证码是 123456，10 分钟内有效。",
    "html": "<p>你的验证码是 <b>123456</b></p>",
    "receivedAt": "2026-05-27T08:01:12.000Z",
    "hasAttachments": false,
    "attachments": []
  }
}`;

  const singleReq = `curl ${base}/api/v1/mailboxes/${sampleAddress}/messages/8f1c-... \\
  -H "Authorization: Bearer $API_TOKEN"`;

  const attachmentReq = `curl ${base}/api/v1/attachments/3a9d-.../download \\
  -H "Authorization: Bearer $API_TOKEN" -OJ`;

  const quickStart = `#!/usr/bin/env bash
set -euo pipefail
BASE="${base}"
API_TOKEN="你的 API_TOKEN"

# 1) 随机创建邮箱（随机域名 + 随机前缀），取出地址
ADDRESS=$(curl -s -X POST "$BASE/api/v1/mailboxes" \\
  -H "Authorization: Bearer $API_TOKEN" | jq -r .address)
echo "新邮箱：$ADDRESS"

# 2) 轮询最新一封未读邮件，直到收到为止
while :; do
  TEXT=$(curl -s "$BASE/api/v1/mailboxes/$ADDRESS/latest?unread=true" \\
    -H "Authorization: Bearer $API_TOKEN" | jq -r '.message.text // empty')
  [ -n "$TEXT" ] && break
  sleep 3
done

# 3) 从正文里抓 6 位验证码
echo "$TEXT" | grep -oE '[0-9]{6}' | head -n1`;

  return (
    <main className="app-shell docs">
      <section className="topbar">
        <div>
          <div className="brand">
            <Code2 size={22} />
            <span>API 文档</span>
          </div>
          <p className="muted">Selfhost Mailbox · 用程序创建邮箱、收取邮件并拿到正文</p>
        </div>
        <div />
        <div className="toolbar-actions">
          <a className="secondary" href="/">
            <ArrowLeft size={16} />
            返回收件箱
          </a>
        </div>
      </section>

      <div className="docs-body">
        <section className="panel doc-section">
          <h2>概览</h2>
          <p>
            这是一套为脚本 / 程序设计的简化接口，用一个全局密钥即可：随机或指定地创建邮箱、轮询收件并直接拿到邮件正文。
            除附件下载外，所有响应均为 JSON。
          </p>
          <ul className="doc-list">
            <li>
              Base URL：<code>{base}</code>
            </li>
            <li>
              所有接口都以 <code>/api/v1</code> 开头；创建邮箱用 <code>POST</code> + JSON 请求体，其余为 <code>GET</code>。
            </li>
          </ul>
        </section>

        <section className="panel doc-section">
          <h2>鉴权</h2>
          <p>
            在服务器 <code>.env</code> 里设置一个长随机字符串 <code>API_TOKEN</code> 并重启，然后每个请求都带上：
          </p>
          <DocCode code={'Authorization: Bearer <你的 API_TOKEN>'} />
          <p>
            也可以改用请求头 <code>X-API-Token: &lt;你的 API_TOKEN&gt;</code>。
          </p>
          {config && !config.apiEnabled ? (
            <div className="doc-warn">
              服务器尚未设置 <code>API_TOKEN</code>，v1 接口当前会返回 <code>503</code>。请在 .env 配置后重启服务。
            </div>
          ) : null}
          <div className="doc-warn subtle">
            该密钥可以创建并读取本服务器上的<strong>所有</strong>邮箱，请妥善保管，仅在受信任的后端使用。
          </div>
        </section>

        <section className="panel doc-section">
          <h2>快速开始</h2>
          <p>
            下面这段脚本完成「随机建邮箱 → 轮询 → 取验证码」的完整流程（需要 <code>curl</code> 和 <code>jq</code>）：
          </p>
          <DocCode label="bash" code={quickStart} />
        </section>

        <section className="panel doc-section">
          <h2>接口</h2>

          <DocEndpoint method="POST" path="/api/v1/mailboxes">
            <p>
              创建邮箱。<strong>不带请求体时随机选一个已配置域名 + 随机前缀</strong>，并在响应里返回创建出的 <code>address</code>；
              也可以指定。默认有效期为 {ttlNote}。
            </p>
            <table className="doc-table">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>类型</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>address</code>
                  </td>
                  <td>string?</td>
                  <td>邮箱前缀或完整地址；省略则随机生成。</td>
                </tr>
                <tr>
                  <td>
                    <code>domain</code>
                  </td>
                  <td>string?</td>
                  <td>指定域名；省略则随机挑一个已配置域名。</td>
                </tr>
                <tr>
                  <td>
                    <code>ttlHours</code>
                  </td>
                  <td>number?</td>
                  <td>有效期小时数；省略用默认值。</td>
                </tr>
                <tr>
                  <td>
                    <code>permanent</code>
                  </td>
                  <td>boolean?</td>
                  <td>
                    <code>true</code> 表示长期保存、不过期。
                  </td>
                </tr>
              </tbody>
            </table>
            <DocCode label="随机创建" code={createRandomReq} />
            <DocCode label="响应 201" code={createRandomRes} />
            <DocCode label="指定地址 / 长期保存" code={createCustomReq} />
          </DocEndpoint>

          <DocEndpoint method="GET" path="/api/v1/mailboxes/:address/messages">
            <p>
              列出邮箱里的邮件，<strong>直接返回正文</strong>（<code>text</code> 与 <code>html</code>），按收件时间倒序。
            </p>
            <table className="doc-table">
              <thead>
                <tr>
                  <th>查询参数</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <code>limit</code>
                  </td>
                  <td>返回条数上限，1–200。</td>
                </tr>
                <tr>
                  <td>
                    <code>unread</code>
                  </td>
                  <td>
                    <code>true</code> 时只返回未读邮件。
                  </td>
                </tr>
              </tbody>
            </table>
            <DocCode label="请求" code={listReq} />
            <DocCode label="响应" code={listRes} />
          </DocEndpoint>

          <DocEndpoint method="GET" path="/api/v1/mailboxes/:address/latest">
            <p>
              取最新一封邮件并附带附件信息，最适合轮询验证码。没有邮件时返回{' '}
              <code>{'{ "success": true, "message": null }'}</code>。支持 <code>unread=true</code>。
            </p>
            <DocCode label="请求" code={latestReq} />
            <DocCode label="响应" code={latestRes} />
          </DocEndpoint>

          <DocEndpoint method="GET" path="/api/v1/mailboxes/:address/messages/:id">
            <p>按邮件 ID 取单封完整内容与附件列表。</p>
            <DocCode label="请求" code={singleReq} />
          </DocEndpoint>

          <DocEndpoint method="GET" path="/api/v1/mailboxes/:address">
            <p>查询邮箱本身信息：创建时间、过期时间、备注等。</p>
          </DocEndpoint>

          <DocEndpoint method="GET" path="/api/v1/attachments/:id/download">
            <p>
              下载附件原始文件。附件 ID 来自单封 / latest 响应里的 <code>attachments[].id</code>，每个附件也带有现成的{' '}
              <code>downloadUrl</code>。
            </p>
            <DocCode label="请求" code={attachmentReq} />
          </DocEndpoint>
        </section>

        <section className="panel doc-section">
          <h2>邮件对象字段</h2>
          <table className="doc-table">
            <thead>
              <tr>
                <th>字段</th>
                <th>类型</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>id</code>
                </td>
                <td>string</td>
                <td>邮件 ID，用于单封查询。</td>
              </tr>
              <tr>
                <td>
                  <code>from</code> / <code>fromName</code>
                </td>
                <td>string</td>
                <td>发件人地址 / 显示名。</td>
              </tr>
              <tr>
                <td>
                  <code>to</code>
                </td>
                <td>string</td>
                <td>收件地址。</td>
              </tr>
              <tr>
                <td>
                  <code>subject</code>
                </td>
                <td>string</td>
                <td>主题。</td>
              </tr>
              <tr>
                <td>
                  <code>text</code> / <code>html</code>
                </td>
                <td>string</td>
                <td>纯文本 / HTML 正文，可能为空字符串。</td>
              </tr>
              <tr>
                <td>
                  <code>receivedAt</code>
                </td>
                <td>string</td>
                <td>收件时间，ISO 8601。</td>
              </tr>
              <tr>
                <td>
                  <code>isRead</code>
                </td>
                <td>boolean</td>
                <td>是否已读（API 读取不会改变已读状态）。</td>
              </tr>
              <tr>
                <td>
                  <code>hasAttachments</code>
                </td>
                <td>boolean</td>
                <td>是否有附件。</td>
              </tr>
              <tr>
                <td>
                  <code>attachments</code>
                </td>
                <td>array</td>
                <td>
                  仅 latest / 单封返回；每项含 <code>id</code>、<code>filename</code>、<code>mimeType</code>、
                  <code>sizeBytes</code>、<code>downloadUrl</code>。
                </td>
              </tr>
            </tbody>
          </table>
        </section>

        <section className="panel doc-section">
          <h2>错误响应</h2>
          <p>
            出错时返回 <code>{'{ "success": false, "error": "..." }'}</code>，并带对应状态码：
          </p>
          <table className="doc-table">
            <thead>
              <tr>
                <th>状态码</th>
                <th>含义</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>401</code>
                </td>
                <td>缺少或错误的 API 密钥。</td>
              </tr>
              <tr>
                <td>
                  <code>404</code>
                </td>
                <td>邮箱 / 邮件 / 附件不存在或已过期。</td>
              </tr>
              <tr>
                <td>
                  <code>409</code>
                </td>
                <td>邮箱地址已存在。</td>
              </tr>
              <tr>
                <td>
                  <code>400</code>
                </td>
                <td>地址或域名不合法。</td>
              </tr>
              <tr>
                <td>
                  <code>503</code>
                </td>
                <td>
                  服务器未配置 <code>API_TOKEN</code>。
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
