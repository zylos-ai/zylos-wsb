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

## 3. 当前保留策略：按体积轮转，默认上限 15 MiB

**默认行为：`data/messages.ndjson` 涨到 5 MiB 就轮转，总共保留 3 份（活动文件 + 2 份归档），
第 4 份在轮转时被删除。** 归档文件名为 `messages.ndjson.1`（最新）、`.2`（次新）。

| 项目 | 默认值 | 覆盖方式 |
|------|--------|----------|
| 单文件上限 | 5 MiB | `WSB_DATA_MAX_BYTES`（字节；**`0` = 关闭轮转**，恢复无限增长） |
| 保留份数 | 3 | `WSB_DATA_KEEP_FILES`（含活动文件；`1` = 只留活动文件，满了直接丢弃） |

非法值（负数、小数、非数字、`WSB_DATA_KEEP_FILES=0`）在启动时直接报错，不会被静默改成默认值。

⚠️ **轮转会真的删除客户数据** —— 被挤出去的那份归档是直接删掉的，不可恢复。
按 5 MiB × 3 估算，磁盘上最多保留约 15 MiB 的历史消息；超出部分**不存在了**。
若你需要完整审计留存，请设 `WSB_DATA_MAX_BYTES=0` 并自行接管归档。

关于「不丢消息」的语义：轮转发生在**写入之后**，所以触发轮转的那条消息本身已经落盘，
不会被它自己触发的轮转吃掉；轮转以**整个文件**为单位丢弃，不会截断出半行 JSON。
轮转后活动文件短暂不存在，下一条消息会重建它，权限仍是 `0600`。

## 4. 谁负责清理 / 怎么清理

**责任人：部署这个 Channel 的 Zylos 运维方**（当前为内部演示，即仓库 owner）。

轮转只管**体积**，不管**对象**：单个客户的删除请求（GDPR 式）仍然要手工做，
而且别忘了归档文件 `messages.ndjson.1` / `.2` 里也有他的记录。

手工清理（服务可不停，采用追加写，清空是安全的）：

```sh
# 看一眼有多大、多少条
wc -lc data/messages.ndjson

# 全部清空（不可恢复）
: > data/messages.ndjson

# 只保留最近 1000 条
tail -n 1000 data/messages.ndjson > data/.keep && mv data/.keep data/messages.ndjson
chmod 600 data/messages.ndjson

# 删除某个号码的全部记录（GDPR 式的单人删除请求）——活动文件和每个归档都要过一遍
# `|| true` 不能省：某个文件里全是他的记录时 grep 无输出会返回 1，会把清空这一步跳掉
for f in data/messages.ndjson data/messages.ndjson.[0-9]; do
  [ -e "$f" ] || continue
  { grep -v '"from":"8613800138000"' "$f" || true; } > data/.keep
  mv data/.keep "$f" && chmod 600 "$f"
done
```

> `mv` 会带走原文件权限，上面每条都补了 `chmod 600`，别省。

## 5. 自动轮转：已实现（v0.2.0）

owner 已拍板实现，行为与参数见第 3 节。实现位于 `src/server.js` 的 `rotateIfFull()`，
在 `createMessageHandler` 每次追加写之后调用；参数校验在 `src/config.js`。

设计取舍，供后续改动时参照：

- **先写后转**：避免消息被它自己触发的轮转丢掉，代价是活动文件会短暂略微超过上限。
- **`renameSync` 而非复制**：归档保留原 inode，因此自动继承 `0600`，无需二次 `chmod`。
- **整文件丢弃**：不做按行裁剪，保证归档里不会出现半行 JSON；代价是删除粒度粗（一次约 5 MiB）。
- **显式 `0` 关闭**：空值取默认，但显式 `0` 被尊重 —— 关闭轮转必须是明确动作，不能是配置写错的副作用。

回归测试见 `test/channel.test.js`（轮转份数、归档权限、记录连续性、关闭开关、参数校验）。

## 6. 不会发生的事

明确划清边界，避免「演示可用」被读成「生产能力」：

- **不上传任何第三方**：消息只写本地文件，并按 `WSB_MODE` 交给本机的 Zylos C4
- **不下载媒体附件**：图片/语音只记录 Meta 给的元数据，不抓取文件本体
- **状态回执不入库**：Meta 的 `sent`/`delivered`/`read` 回执走 `value.statuses`，
  而解析只读 `value.messages`（`src/channel.js`），因此回执**不会**产生新记录。
  → 排障含义：**Webhook 返回 200 但 `messages.ndjson` 没有新行，通常是状态回执，不是故障。**
- **凭证不落盘到这里**：Access Token / App Secret 只在 `.env`，不写入数据文件、不打日志
