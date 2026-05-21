# cloud-mail-server

[English README](README-EN.md)

> 讓標準郵件客戶端（Thunderbird、Outlook、Apple Mail 等）透過 IMAP / SMTP 連接到自架的 [cloud-mail](https://github.com/maillab/cloud-mail) Worker 的中介伺服器。

由於 cloud-mail 完全運行在 **Cloudflare Workers**（僅 HTTP）上，一般郵件客戶端無法直接用 IMAP 或 SMTP 連線。  
cloud-mail-server 會在**本機**（或你控制的任意伺服器）運行，負責做協定轉換：

```
Email Client -> IMAP/SMTP -> cloud-mail-server -> HTTPS -> cloud-mail Worker
```

---

## 功能

| 協定 | 預設連接埠 | 功能說明 |
|----------|---------------|--------------|
| **IMAP4rev1** | 143 | 透過 cloud-mail API 收信、讀信與刪信 |
| **SMTP** | 587 | 透過 cloud-mail API 寄信 |

### IMAP 支援內容
- **INBOX** 資料夾：收到的信件（`type=0`），若帳號有多個收件地址，會動態出現 `INBOX/<address>` 子資料夾
- **Sent** 資料夾：寄出的信件（`type=1`）
- **Trash** 資料夾：僅限目前連線工作階段的垃圾桶（移入或複製到此的信件會暫存在記憶體；cloud-mail 本身沒有原生垃圾桶概念）
- `FETCH`：支援 `FLAGS`、`UID`、`INTERNALDATE`、`RFC822.SIZE`、`RFC822`、`ENVELOPE`、`BODY[...]`、`BODYSTRUCTURE`
- `COPY` / `UID COPY`：複製訊息到 Trash（RFC 3501 Section 6.4.7）
- `MOVE` / `UID MOVE`：搬移訊息到 Trash，並立即從 API 刪除原訊息（RFC 6851）
- `STORE`：標記 `\Seen` / `\Deleted`
- `EXPUNGE`：永久刪除已標記訊息（對 Trash 執行 expunge 時，也會永久刪除已複製但尚未 expunge 的訊息）
- `SEARCH`：基礎支援，回傳所有訊息
- `IDLE`：已回應支援（以輪詢 re-SELECT 機制檢查新信）

---

## 需求

- **Node.js** >= 18
- 可運行中的 [cloud-mail](https://github.com/maillab/cloud-mail) worker（`CLOUD_MAIL_URL`）

---

## 快速開始

```bash
# 1. 下載並安裝
git clone https://github.com/codefz840/cloud-mail-server.git
cd cloud-mail-server
npm install

# 2. 設定環境
cp .env.example .env
# 編輯 .env，設定 CLOUD_MAIL_URL 為你的 cloud-mail worker URL

# 3. 啟動
npm start
```

---

## 設定

所有設定都來自環境變數（或專案根目錄的 `.env` 檔）。

| 變數 | 預設值 | 說明 |
|----------|---------|-------------|
| `CLOUD_MAIL_URL` | *(必填)* | cloud-mail worker 的基底 URL，例如 `https://mail.example.com` |
| `IMAP_PORT` | `143` | IMAP 伺服器 TCP 連接埠 |
| `SMTP_PORT` | `587` | SMTP 伺服器 TCP 連接埠 |
| `HOST` | `0.0.0.0` | 綁定網路介面（若只允許本機，使用 `127.0.0.1`） |

`.env` 範例：

```env
CLOUD_MAIL_URL=https://mail.example.com
IMAP_PORT=143
SMTP_PORT=587
HOST=127.0.0.1
```

---

## 郵件客戶端設定

### Thunderbird

1. **新增帳號** -> *手動設定*
2. **收件（IMAP）**
   - 伺服器：`localhost`（或 cloud-mail-server 所在主機 IP）
   - 連接埠：`143`
   - 連線安全性：**無**（若你另外加上 TLS，也可用 STARTTLS）
   - 驗證方式：**一般密碼**
   - 使用者名稱：你的 cloud-mail 信箱地址（例如 `you@example.com`）
3. **寄件（SMTP）**
   - 伺服器：`localhost`
   - 連接埠：`587`
   - 連線安全性：**無**
   - 驗證方式：**一般密碼**
   - 使用者名稱：你的 cloud-mail 信箱地址

### Apple Mail / Outlook

沿用同一組參數：
- IMAP 主機 `localhost`，連接埠 `143`，無 TLS，一般密碼驗證
- SMTP 主機 `localhost`，連接埠 `587`，無 TLS，一般密碼驗證

> **提示：** 若 cloud-mail-server 跑在遠端主機，請把 `localhost` 改成該主機 IP 或網域。  
> 也可自行加上 TLS（例如用 Nginx 或 Caddy 反向代理），改用 993（IMAP）/ 465（SMTP）進行加密連線。

---

## 專案結構

```
cloud-mail-server/
├── src/
│   ├── api/
│   │   └── cloud-mail-client.js   # cloud-mail REST API 的 HTTP 客戶端
│   ├── imap/
│   │   └── imap-server.js         # IMAP4rev1 TCP 伺服器
│   ├── smtp/
│   │   └── smtp-server.js         # SMTP 伺服器（smtp-server 套件）
│   ├── utils/
│   │   └── mime-builder.js        # 將 cloud-mail 物件轉成 RFC 2822 MIME
│   └── index.js                   # 進入點
├── tests/
│   ├── mime-builder.test.js
│   └── imap-helpers.test.js
├── .env.example
├── config.js
└── package.json
```

---

## 開發

```bash
# 檔案變更時自動重啟（Node >= 18）
npm run dev

# 執行測試
npm test
```

當你有設定下列環境變數時，cloud-mail API 的整合測試也會使用：

```env
TEST_MAIL_USER=your-test-mail-address@example.com
TEST_MAIL_PASS=your-test-mail-password
CLOUD_MAIL_URL=https://mail.example.com
```

## CI

GitHub Actions 會在每次 push 與 pull request 執行 `npm test`。若儲存庫 secrets 或 variables 有設定 `TEST_MAIL_USER`、`TEST_MAIL_PASS`、`CLOUD_MAIL_URL`，整合測試流程會一併驗證實際 cloud-mail API。

---

## 授權

MIT
