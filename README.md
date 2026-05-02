# Selfhost Mailbox

一个不依赖 Cloudflare 的自托管临时邮箱。它自己监听 SMTP，收进来的邮件会解析后写入 Postgres，再通过 Web 界面查看。

## SMTP 难不难

只做“收信”不难，尤其是临时邮箱这种场景。真正麻烦的是发信信誉、SPF/DKIM/DMARC 对齐、IP 预热和退信处理；本项目暂时不做发信，所以复杂度低很多。

自建收信需要满足三件事：

- VPS 有公网 IP，并且服务商没有封入站 25 端口。
- 域名可以改 DNS，至少能配置 `MX` 记录。
- SMTP 服务不能做开放中继。本项目禁用认证和转发，只接收已创建邮箱地址的邮件。

## 架构

```text
发件方 SMTP
  -> 你的域名 MX
  -> 本项目 SMTP 服务
  -> mailparser 解析邮件
  -> Postgres 存邮箱、邮件、附件
  -> React Web 界面查看
```

## 功能

- 多邮箱管理：同一个浏览器会保存已创建邮箱的 token，可以在侧栏切换地址，创建新地址不会覆盖旧地址。
- 邮箱备注：地址管理里可以给每个邮箱写简短备注，用来标记这个地址给谁或哪个服务用了。
- 删除邮箱：地址管理里可以删除单个邮箱，删除会同时移除这个邮箱收到的邮件和附件。
- 长期保存：创建邮箱时可选择“长期”，数据库里的 `expires_at` 会置空，清理任务不会删除这个邮箱及其邮件。
- 只读分享：管理界面可为某个邮箱生成 `/share/<token>` 链接，对方只能查看这个邮箱的收件箱、邮件正文和附件，不能创建、删除或进入管理功能。
- 服务器同步：设置 `ADMIN_TOKEN` 后，新浏览器或新域名页面也可以用管理密钥加载服务器里已有邮箱和历史邮件。

## 本地开发

```bash
cp .env.example .env
```

先启动数据库：

```bash
docker compose up -d postgres
```

安装依赖并启动开发服务：

```bash
npm install
npm run dev:api
npm run dev:web
```

默认端口：

- Web: `http://localhost:5173`
- API: `http://localhost:3000`
- SMTP: `127.0.0.1:2525`

## Docker 部署

编辑 `.env`：

```env
EMAIL_DOMAINS=example.com,example.net
PUBLIC_BASE_URL=https://mail.example.com
ADMIN_TOKEN=replace-with-a-long-random-secret
SMTP_PUBLISH_PORT=25
HTTP_PUBLISH_PORT=3000
POSTGRES_USER=mailbox
POSTGRES_PASSWORD=change-me
POSTGRES_DB=mailbox
```

启动：

```bash
docker compose up -d --build
```

生产环境建议在前面放 Caddy/Nginx 做 HTTPS，然后把 `mail.example.com` 反代到 `app:3000`。

## DNS 配置

假设服务器 IP 是 `203.0.113.10`，Web/API 域名是 `mail.example.com`，MX 主机是 `mx.example.com`：

```dns
mx.example.com.    A     203.0.113.10
example.com.       MX    10 mx.example.com.
```

如果还有 `example.net`：

```dns
example.net.       MX    10 mx.example.com.
```

然后在 `.env` 里加入：

```env
EMAIL_DOMAINS=example.com,example.net
```

## 可选 STARTTLS

没有 TLS 也能收很多邮件，但生产环境建议给 SMTP 配证书。准备好证书后挂载到容器，并设置：

```env
SMTP_TLS_KEY_PATH=/certs/privkey.pem
SMTP_TLS_CERT_PATH=/certs/fullchain.pem
```

## 本地发测试邮件

创建邮箱后，可以用 `swaks` 测试：

```bash
swaks --server 127.0.0.1:2525 --to test@example.com --from sender@example.org --header "Subject: hello" --body "验证码 123456"
```

`test@example.com` 要换成 Web 界面里实际创建出来的地址。

## API

- `GET /api/config`
- `POST /api/mailboxes`，请求体可包含 `address`、`domain`、`ttlHours`、`permanent`
- `GET /api/mailboxes/:address`
- `PATCH /api/mailboxes/:address`，用于把已有邮箱改为长期保存、重设有效期或更新备注
- `DELETE /api/mailboxes/:address`
- `POST /api/mailboxes/:address/share`
- `DELETE /api/mailboxes/:address/share`
- `GET /api/mailboxes/:address/messages`
- `GET /api/messages/:id`
- `DELETE /api/messages/:id`
- `GET /api/messages/:id/attachments`
- `GET /api/attachments/:id/download`
- `GET /api/admin/mailboxes`
- `PATCH /api/admin/mailboxes/:address`
- `DELETE /api/admin/mailboxes/:address`
- `GET /api/admin/mailboxes/:address/messages`
- `GET /api/admin/messages/:id`
- `GET /api/admin/messages/:id/attachments`
- `GET /api/admin/attachments/:id/download`
- `GET /api/shared/:shareToken/mailbox`
- `GET /api/shared/:shareToken/messages`
- `GET /api/shared/:shareToken/messages/:id`
- `GET /api/shared/:shareToken/messages/:id/attachments`
- `GET /api/shared/:shareToken/attachments/:id/download`

创建邮箱会返回 `token`，之后读取和删除都需要请求头：

```http
X-Mailbox-Token: <token>
```

分享接口会返回 `share.url`。分享 token 单独存储哈希，不等同于邮箱管理 token。

管理接口需要请求头：

```http
X-Admin-Token: <ADMIN_TOKEN>
```

`ADMIN_TOKEN` 适合设置成一段长随机字符串。它不会暴露给分享页；只有输入该密钥的管理界面可以跨浏览器加载服务器里的历史邮箱。
