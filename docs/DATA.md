# 数据边界与留存契约

本文件说明这个 Channel **实际会持久化什么客户数据、存多久、谁负责清理**。
描述的是当前代码的真实行为（`src/server.js`），不是目标状态。

## 1. 会落盘的内容

每收到一条**客户消息**，`src/server.js` 会向 `data/messages.ndjson` 追加一行 JSON：

| 字段 | 内容 | 是否属于个人信息 |
|------|------|------------------|
| `receivedAt` | 服务端收到的 ISO 时间 | 否 |
| `id` | Meta 消息 ID（`wamid.…`） | 间接 |
| `from` | **客户的 WhatsApp 号码**（纯数字） | **是** |
| `name` | **客户的 WhatsApp 昵称** | **是** |
| `phoneNumberId` | 我方业务号 ID | 否 |
| `timestamp` | Meta 给出的消息时间 | 否 |
| `type` | 消息类型（`text` / `image` / …） | 否 |
| `text` | **文字消息正文全文** | **是** |
| `raw` | **Meta 原始消息对象，原样保存** | **是** |

> ⚠️ `raw` 是整条原始回调消息，字段随 Meta 的消息类型变化。非文字消息（图片、
> 位置、名片等）的元数据——例如媒体 ID、caption、经纬度——都会落在这里。
> 换句话说：**落盘范围不止上表列出的字段**，不要假设只有 `text` 含正文。

## 2. 存放位置与权限

- 路径：`data/messages.ndjson`（可用 `WSB_DATA_DIR` 覆盖目录）
- 目录权限 `0700`，文件权限 `0600`，每次启动强制重设
- 已在 `.gitignore` 中，不会进仓库；CI 也会拦截打包泄漏（`.github/workflows/ci.yml`）
- **`zylos upgrade` 会保留 `data/`** —— 升级不清数据

## 3. 当前保留策略：无

**现状是无限增长。** 没有轮转、没有保留期、没有自动删除、没有脱敏。
文件会一直变大，直到磁盘写满或有人手工清理。

这是**已知缺口**，不是刻意设计。在下面第 5 节的决策落定前，请按
「这台机器上存着未过期的客户手机号和聊天正文」来对待它。

## 4. 谁负责清理 / 怎么清理

**责任人：部署这个 Channel 的 Zylos 运维方**（当前为内部演示，即仓库 owner）。

手工清理（服务可不停，采用追加写，清空是安全的）：

```sh
# 看一眼有多大、多少条
wc -lc data/messages.ndjson

# 全部清空（不可恢复）
: > data/messages.ndjson

# 只保留最近 1000 条
tail -n 1000 data/messages.ndjson > data/.keep && mv data/.keep data/messages.ndjson
chmod 600 data/messages.ndjson

# 删除某个号码的全部记录（GDPR 式的单人删除请求）
grep -v '"from":"8613800138000"' data/messages.ndjson > data/.keep && mv data/.keep data/messages.ndjson
chmod 600 data/messages.ndjson
```

> `mv` 会带走原文件权限，上面每条都补了 `chmod 600`，别省。

## 5. 待决策：是否实现自动轮转

倾向方案：单文件上限 ~5 MB、最多保留 3 份、超出自动丢弃最旧的一份。

**尚未实现，需要 owner 拍板** —— 因为自动轮转意味着**代码会主动删除客户数据**，
这是个策略决定，不是实现细节。在拍板前本文件即为唯一的留存契约。

## 6. 不会发生的事

明确划清边界，避免「演示可用」被读成「生产能力」：

- **不上传任何第三方**：消息只写本地文件，并按 `WSB_MODE` 交给本机的 Zylos C4
- **不下载媒体附件**：图片/语音只记录 Meta 给的元数据，不抓取文件本体
- **状态回执不入库**：Meta 的 `sent`/`delivered`/`read` 回执走 `value.statuses`，
  而解析只读 `value.messages`（`src/channel.js`），因此回执**不会**产生新记录。
  → 排障含义：**Webhook 返回 200 但 `messages.ndjson` 没有新行，通常是状态回执，不是故障。**
- **凭证不落盘到这里**：Access Token / App Secret 只在 `.env`，不写入数据文件、不打日志
