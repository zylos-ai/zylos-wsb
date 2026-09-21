# 排查

## 先分清是哪一条链路

入站和出站是**两条完全独立**的链路，用的凭证也不同。先定位在哪一侧，再往下看：

| 链路 | 路径 | 相关凭证 |
|------|------|----------|
| **入站** | Meta → 公网 HTTPS → Caddy → `127.0.0.1:47832` → `data/messages.ndjson` → C4 | `WSB_VERIFY_TOKEN`（握手）、`WSB_APP_SECRET`（签名） |
| **出站** | `scripts/send.js` → Graph API → 客户手机 | `WSB_ACCESS_TOKEN`、`WSB_PHONE_NUMBER_ID` |

> 典型误判：Access Token 过期（出站全挂）时，入站其实一切正常，回调照常 200 落库。
> 反过来也一样。**看到「不通」先问是哪一侧。**

## 入站：回调到底有没有到

按顺序排除，不要跳步：

1. **请求有没有到机器** —— 看 Zylos 的 Caddy 访问日志（JSON 每行一条）：

   ```sh
   grep whatsapp ~/zylos/http/caddy-access.log | tail -20
   ```

   没有任何记录 = 请求根本没到，问题在 Meta 订阅 / 公网域名 / DNS / 证书，不在本 Channel。

2. **到了但返回非 200** —— 403 通常是签名或握手参数不对，见下一节。

3. **返回 200 但 `data/messages.ndjson` 没有新行** —— 多半是**状态回执**
   （`sent`/`delivered`/`read`），解析只收真实消息，回执不入库。**这不是故障**，
   详见 [DATA.md](DATA.md) 第 6 节。另一种可能是样例回调的 Phone Number ID 不匹配，被忽略。

### 自测 Verify 握手的正确姿势

必须带齐三个查询参数，**裸 GET 一定返回 403，这是设计如此，不是故障**：

```sh
curl "https://<你的公网域名>/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=<WSB_VERIFY_TOKEN>&hub.challenge=hello"
# 预期原样返回：hello
```

### 其他入站症状

- **`check` 成功但没有回调**：检查公网地址、端口、`messages` 字段订阅、WABA 的 App 订阅和 Phone Number ID。
- **`webhook` 提示未找到匹配路由**：查看 Zylos 安装输出中的 Caddy 错误，并核对端口；仅执行 `npm run setup` 不会自动配置服务器路由。
- **已收到回调但 Zylos 无回复**：确认 `WSB_MODE=c4`、Channel 链接、C4 dispatcher、主会话状态和发送日志。

## 出站：Meta 错误码

| 码 | 含义 | 处理 |
|----|------|------|
| `190` | Access Token 失效或过期 | 换新 Token。临时令牌有效期 24 小时，长期方案用 System User 长期令牌 |
| `131047` | 24 小时回复窗口已关闭 | 只能用模板消息，本 Demo 不含模板发送 |
| `131030` | 测试收件人未加入允许列表 | 在 Meta 后台把该号码加进测试接收人 |
| `131005` | 同上（收件人不在允许列表） | 同上 |
| `131031` | 账号受限 | 需在 Meta 侧处理 |

快速核对当前 Token 和号码是否还有效：

```sh
set -a && . .env && set +a
curl -s "https://graph.facebook.com/v25.0/$WSB_PHONE_NUMBER_ID" \
  -H "Authorization: Bearer $WSB_ACCESS_TOKEN"
```

返回 `190` 说明是**令牌**问题，与收件人白名单无关——纯读取调用也会失败。

## 其他

- **API 超时可能已经发送**：确认手机是否收到再重试。Meta 返回消息 ID 只代表请求被接受，不保证最终送达。
- **重复消息**在进程内去重，处理失败返回 503；重启会清空去重记录，失败重试可能留下重复日志。无数据库或持久队列，**不承诺恰好处理一次**。
- **单进程运行**。更改端口时，ngrok / 反向代理以及 `SKILL.md` 的 `http_routes.target` 都要同步更新。
- **隔离 Zylos 排查**：把 `.env` 的 `WSB_MODE` 改成 `echo` 并重启，预期收到 `收到：你发的内容`；完成后切回 `c4` 并重启。
