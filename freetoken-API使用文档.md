# Freetoken 邮箱 API 使用文档（v1）

面向脚本 / 自动化的简化接口：用一把全局密钥即可**创建邮箱、轮询收件并直接拿到邮件正文**。除附件下载外，所有响应均为 JSON。

- **Base URL**：`https://freetoken.cc.cd`
- **在线文档**：<https://freetoken.cc.cd/docs>
- 所有接口都以 `/api/v1` 开头；创建邮箱用 `POST` + JSON 请求体，其余为 `GET`。

---

## 鉴权

每个请求都要带上下面的请求头（二选一）：

```http
Authorization: Bearer <API_TOKEN>
```
或
```http
X-API-Token: <API_TOKEN>
```

当前部署的密钥：

```
26dd3ad86b6549550690a0fe9f10cd5146323195299aff100bb2b3de6d976cb3
```

> ⚠️ **保密**：这把密钥可以创建并读取本服务器上的**所有**邮箱，只在你信任的后端使用。它存放在服务器 `/root/selfhost-mailbox/.env` 的 `API_TOKEN` 里；想更换就改这行再 `docker compose up -d` 即可。

---

## 可用域名

不指定 `domain` 时，会从下面这些已配置域名里**随机**挑一个：

```
echoview.tech
intellect-ai.app
peipe.me
oriange.stusite.me
neuralis.systems
aureon.qzz.io
```

> API 创建的邮箱默认 **24 小时**后过期（最长可设 168 小时）。要长期保存就在创建时传 `{"permanent": true}`。

---

## 接口

### 1. 创建邮箱

```
POST /api/v1/mailboxes
```

不带请求体时会**随机选一个域名 + 随机前缀**并返回创建出的地址；也可以指定。

请求体字段（全部可选，`Content-Type: application/json`）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `address` | string | 邮箱前缀（如 `login-test`）或完整地址（如 `me@peipe.me`）；省略则随机生成 |
| `domain` | string | 指定域名；省略则随机挑一个已配置域名 |
| `ttlHours` | number | 有效期小时数（1–168）；省略用默认 24 |
| `permanent` | boolean | `true` 表示长期保存、不过期 |

**随机创建：**

```bash
curl -X POST https://freetoken.cc.cd/api/v1/mailboxes \
  -H "Authorization: Bearer $API_TOKEN"
```

**响应 `201`：**

```json
{
  "success": true,
  "address": "fevvqzjwnz4@aureon.qzz.io",
  "localPart": "fevvqzjwnz4",
  "domain": "aureon.qzz.io",
  "createdAt": "2026-05-27T05:30:36.801Z",
  "expiresAt": "2026-05-28T05:30:36.801Z",
  "token": "mWbAuELQ..."
}
```

> `token` 是该邮箱的独立密钥（可配合标准 `/api` 接口使用）；用全局 `API_TOKEN` 调用 v1 时可以忽略它。

**指定地址 / 长期保存：**

```bash
curl -X POST https://freetoken.cc.cd/api/v1/mailboxes \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"address": "login-test", "domain": "peipe.me", "permanent": true}'
```

---

### 2. 列出邮件（含正文）

```
GET /api/v1/mailboxes/:address/messages
```

列出邮箱里的邮件，**直接返回正文**（`text` 与 `html`），按收件时间倒序。

查询参数：

| 参数 | 说明 |
|---|---|
| `limit` | 返回条数上限，1–200 |
| `unread` | `true` 时只返回未读邮件 |

```bash
curl "https://freetoken.cc.cd/api/v1/mailboxes/fevvqzjwnz4@aureon.qzz.io/messages" \
  -H "Authorization: Bearer $API_TOKEN"
```

**响应：**

```json
{
  "success": true,
  "address": "fevvqzjwnz4@aureon.qzz.io",
  "count": 1,
  "messages": [
    {
      "id": "c5b0cdfa-19a9-42e6-b7ff-b4bc1fb8e2dc",
      "from": "tester@example.org",
      "fromName": "",
      "to": "fevvqzjwnz4@aureon.qzz.io",
      "subject": "API 测试邮件",
      "text": "你的验证码是 654321，5分钟内有效。",
      "html": "",
      "receivedAt": "2026-05-27T05:31:55.887Z",
      "isRead": false,
      "sizeBytes": 269,
      "hasAttachments": false
    }
  ]
}
```

---

### 3. 取最新一封（适合轮询验证码）

```
GET /api/v1/mailboxes/:address/latest
```

取最新一封邮件并附带附件信息。没有邮件时返回 `{ "success": true, "message": null }`。支持 `?unread=true`。

```bash
curl "https://freetoken.cc.cd/api/v1/mailboxes/fevvqzjwnz4@aureon.qzz.io/latest?unread=true" \
  -H "Authorization: Bearer $API_TOKEN"
```

**响应：**

```json
{
  "success": true,
  "message": {
    "id": "c5b0cdfa-19a9-42e6-b7ff-b4bc1fb8e2dc",
    "from": "tester@example.org",
    "subject": "API 测试邮件",
    "text": "你的验证码是 654321，5分钟内有效。",
    "html": "",
    "receivedAt": "2026-05-27T05:31:55.887Z",
    "hasAttachments": false,
    "attachments": []
  }
}
```

---

### 4. 取单封完整内容

```
GET /api/v1/mailboxes/:address/messages/:id
```

按邮件 `id`（来自列表 / latest 响应）取单封完整内容与附件列表。

```bash
curl "https://freetoken.cc.cd/api/v1/mailboxes/fevvqzjwnz4@aureon.qzz.io/messages/c5b0cdfa-..." \
  -H "Authorization: Bearer $API_TOKEN"
```

---

### 5. 查询邮箱信息

```
GET /api/v1/mailboxes/:address
```

返回邮箱本身信息：创建时间、过期时间、备注等。

```bash
curl "https://freetoken.cc.cd/api/v1/mailboxes/fevvqzjwnz4@aureon.qzz.io" \
  -H "Authorization: Bearer $API_TOKEN"
```

---

### 6. 下载附件

```
GET /api/v1/attachments/:id/download
```

下载附件原始文件。附件 `id` 来自单封 / latest 响应里的 `attachments[].id`，每个附件也带有现成的 `downloadUrl`。

```bash
curl "https://freetoken.cc.cd/api/v1/attachments/3a9d-.../download" \
  -H "Authorization: Bearer $API_TOKEN" -OJ
```

---

## 邮件对象字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 邮件 ID，用于单封查询 |
| `from` / `fromName` | string | 发件人地址 / 显示名 |
| `to` | string | 收件地址 |
| `subject` | string | 主题 |
| `text` / `html` | string | 纯文本 / HTML 正文，可能为空字符串 |
| `receivedAt` | string | 收件时间，ISO 8601 |
| `isRead` | boolean | 是否已读（API 读取**不会**改变已读状态）|
| `hasAttachments` | boolean | 是否有附件 |
| `attachments` | array | 仅 latest / 单封返回；每项含 `id`、`filename`、`mimeType`、`sizeBytes`、`downloadUrl` |

---

## 错误响应

出错时返回 `{ "success": false, "error": "..." }`，并带对应状态码：

| 状态码 | 含义 |
|---|---|
| `401` | 缺少或错误的 API 密钥 |
| `404` | 邮箱 / 邮件 / 附件不存在或已过期 |
| `409` | 邮箱地址已存在 |
| `400` | 地址或域名不合法 |
| `503` | 服务器未配置 `API_TOKEN` |

---

## 完整示例

### Bash（创建 → 轮询 → 取验证码）

需要 `curl` 和 `jq`：

```bash
#!/usr/bin/env bash
set -euo pipefail
BASE="https://freetoken.cc.cd"
API_TOKEN="26dd3ad86b6549550690a0fe9f10cd5146323195299aff100bb2b3de6d976cb3"

# 1) 随机创建邮箱（随机域名 + 随机前缀），取出地址
ADDRESS=$(curl -s -X POST "$BASE/api/v1/mailboxes" \
  -H "Authorization: Bearer $API_TOKEN" | jq -r .address)
echo "新邮箱：$ADDRESS"

# 2) 轮询最新一封未读邮件，直到收到为止
while :; do
  TEXT=$(curl -s "$BASE/api/v1/mailboxes/$ADDRESS/latest?unread=true" \
    -H "Authorization: Bearer $API_TOKEN" | jq -r '.message.text // empty')
  [ -n "$TEXT" ] && break
  sleep 3
done

# 3) 从正文里抓 6 位验证码
echo "$TEXT" | grep -oE '[0-9]{6}' | head -n1
```

### Python（创建 → 轮询 → 取验证码）

需要 `pip install requests`：

```python
import re
import time
import requests

BASE = "https://freetoken.cc.cd"
TOKEN = "26dd3ad86b6549550690a0fe9f10cd5146323195299aff100bb2b3de6d976cb3"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def create_mailbox(address=None, domain=None, permanent=False):
    body = {}
    if address:
        body["address"] = address
    if domain:
        body["domain"] = domain
    if permanent:
        body["permanent"] = True
    r = requests.post(f"{BASE}/api/v1/mailboxes", json=body or None, headers=HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()["address"]


def wait_for_code(address, pattern=r"\d{4,8}", timeout=120, interval=3):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = requests.get(
            f"{BASE}/api/v1/mailboxes/{address}/latest",
            params={"unread": "true"},
            headers=HEADERS,
            timeout=15,
        )
        msg = r.json().get("message")
        if msg:
            m = re.search(pattern, msg.get("text", "") or "")
            if m:
                return m.group()
        time.sleep(interval)
    raise TimeoutError("等待邮件超时")


if __name__ == "__main__":
    addr = create_mailbox()
    print("新邮箱：", addr)
    print("验证码：", wait_for_code(addr))
```

---

## 运维备注

- 部署：本地改完 `git push origin main`，服务器 `cd /root/selfhost-mailbox && git pull --ff-only && docker compose up -d --build`。
- 改密钥：编辑服务器 `/root/selfhost-mailbox/.env` 里的 `API_TOKEN=`，然后 `docker compose up -d` 重启 app 即可（无需重新构建）。

*文档生成于 2026-05-27，对应已部署版本。*
