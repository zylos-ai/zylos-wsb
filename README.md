# WhatsApp Business Channel for Zylos

一个用于演示的 WhatsApp Business Cloud API Channel：客户给商家号发文字消息，Zylos 接收、理解并回复到同一个聊天。

```text
WhatsApp → Meta Webhook → HTTPS 回调 → wsb Channel → Zylos
WhatsApp ← Meta Cloud API ← scripts/send.js ← C4 回复
```

渠道名 `wsb`，默认端口 `47832`，无第三方依赖。本包不包含 Access Token、App Secret、个人手机号或聊天记录。

## 服务器安装：自动提供 Webhook 地址

需要已有的 Zylos、`comm-bridge` 和 Node.js >= 20.20。Zylos 的 HTTP 层应已配置公网域名与 HTTPS（通常在 `zylos init` 时设置）。Channel 复用这个域名，不需要另开公网端口。

直接从 GitHub 安装：

```sh
zylos add zylos-ai/zylos-wsb --branch main
```

如果使用压缩包交付，也可以解压后在 `wsb-channel` 的上一级目录运行：

```sh
zylos add ./wsb-channel
```

两种方式均按安装提示提供下面三项 Meta 凭证。Zylos 会把 Channel 安装到 `~/zylos/.claude/skills/wsb`，保存凭证到 `~/zylos/.env`，自动添加 `/whatsapp/webhook` 路由并启动服务。安装 hook 会创建私有配置、生成 Verify Token，并读取 Zylos 的 `.zylos/config.json`，显示地址，例如：

```text
[wsb] Callback URL: https://你的Zylos域名/whatsapp/webhook
```

HTTPS 请求经 Zylos 的 Caddy 转发到本机 `127.0.0.1:47832`。沿用默认端口；更改端口必须同步修改 `SKILL.md` 的 `http_routes.target` 并重新应用路由。域名、DNS 和证书必须已可用；安装时显示地址不代表已验证公网连通。

如果 Zylos 不在默认目录，安装前设置 `ZYLOS_DIR`。新建 Channel 配置会记住该目录。已经安装过 `wsb` 时使用 Zylos 的升级流程，保留 `.env` 和 `data/`，不要重复安装另一份。

安装后可在 Channel 目录检查配置或再次查看地址：

```sh
cd ~/zylos/.claude/skills/wsb
npm run check
npm run webhook
```

若让 Zylos 代装，它需完成标准安装流程中的配置、post-install hook 和服务启动。`zylos add --json` 只执行基础安装并返回这些后续步骤，单独运行它不算完成安装。

### 配置项

使用同一个 Meta App / WhatsApp 账号对应的凭证：

| 配置 | 填什么 |
| --- | --- |
| `WSB_ACCESS_TOKEN` | 安装时提供，API 测试页的访问令牌；临时令牌过期后需更新 |
| `WSB_PHONE_NUMBER_ID` | Phone number ID，不能填手机号、App ID 或 WABA ID |
| `WSB_APP_SECRET` | App settings → Basic → App secret |
| `WSB_VERIFY_TOKEN` | 安装时自动生成到 Channel 的 `.env`；如果 Zylos 已有此项则沿用。稍后在 Meta 填相同值 |
| `WSB_MODE` | 默认 `c4`，由 Zylos 回复；`echo` 用于排查收发，`log` 只记录 |

凭证读取顺序为进程环境、Channel 的 `.env`、Zylos 的 `.env`。新建本地配置的空凭证项保持注释，不会覆盖安装时收集的全局凭证。需要本地覆盖时取消对应项的注释并填入值。重复运行安装 hook 会保留现有 `.env`，不重新生成 Token。

安装结束会逐项显示「已配置 / 待填写」，提供获取位置和实际 `.env` 文件路径。缺少凭证时，状态为「Channel 文件已就位，配置尚未完成」；先编辑提示的文件，取消缺失项前面的 `#` 并填值，保存后运行 `npm run check`。已配置项无需重填，已有 `.env` 不要用模板覆盖。检查通过后，启动或重启 Channel，再去 Meta 填回调。

Zylos 代装时，应把这份清单展示给用户，并询问缺失项，或让用户直接编辑 `.env`；凭证不能在安装总结中回显。终端安装使用 Zylos 原有的配置输入提示，post-install hook 不再打开额外输入框，避免自动安装等待 stdin。若终端安装时跳过了必填项，服务的配置验证会阻止正常启动；补齐后用 `pm2 restart zylos-wsb` 重试。

## 本机调试 / 没有 Zylos 公网域名

在源码目录运行：

```sh
npm run setup
# 编辑 .env，取消凭证项的注释并填写
npm run check
npm start
```

`npm run setup` 创建私有 `.env` 并将源码目录链接到 Zylos；已有另一份 Channel 时会停止，避免覆盖。这个开发命令不会注册 Caddy 路由或启动服务，服务器应使用上面的 `zylos add`。需要保留源码目录，回复脚本通过链接使用它。

没有公网域名时，安装输出会提示 ngrok；HTTP 域名也会提示先配置 HTTPS，不会显示成可用的 Meta 回调。安装 ngrok 并配置自己的 Authtoken 后，另开一个终端运行：

```sh
sh start-ngrok.sh
```

将 ngrok 的 HTTPS 地址加上 `/whatsapp/webhook`。如果使用自建 HTTPS 代理，将此路径转发到 `http://127.0.0.1:47832/whatsapp/webhook` 即可。

## 在 Meta 填写回调

复制安装输出的服务器地址，或上面得到的 ngrok 地址：

```text
Callback URL: https://<你的公网域名>/whatsapp/webhook
Verify token: WSB_VERIFY_TOKEN 的实际值
```

Verify Token 默认保存在 Channel 的私有 `.env`，不会打印到安装日志。如果安装时沿用了 Zylos 的值，从 Zylos `.env` 读取。先确认 Channel 服务正在运行，再到 Meta 验证并保存；安装不会自动修改 Meta 控制台。

在 Meta 验证并保存回调后，还要完成两层订阅：

1. 在 Webhook 字段列表中订阅 `messages`。
2. 确认当前 WhatsApp Business Account（WABA）订阅了这个 App。

检查第二步：用该 App 的 Access Token 调用 `GET /<WABA_ID>/subscribed_apps`，确认返回自己的 App ID；若缺失，调用 `POST /<WABA_ID>/subscribed_apps`，再 GET 确认。使用 `Authorization: Bearer <ACCESS_TOKEN>`，完整地址为 `https://graph.facebook.com/<WSB_GRAPH_VERSION>/...`。WABA ID 在 API 测试页获取，与 Phone Number ID 不同。参考 [Meta 官方订阅接口](https://www.postman.com/meta/whatsapp-business-platform/request/ju40fld/subscribe-app-to-waba-s-webhooks)。

若复用同一个 Meta App，更换 Callback URL 会把后续回调切到新机器；在新机器准备好后再切换。

## 演示验收

使用 Meta 测试号码时，先把演示者的 WhatsApp 号码添加为测试接收人并完成验证。

让演示者发一个具体问题，例如「帮我写一句咖啡店欢迎语」。验收标准：

- 本地 `data/messages.ndjson` 出现该消息。
- Zylos 收到来自 `wsb` 的消息。
- 同一 WhatsApp 聊天收到 Zylos 生成的回答。

```sh
tail -f data/messages.ndjson
```

Meta 控制台的“发送样例回调”只证明回调地址可达。样例的 Phone Number ID 不匹配时会被忽略，返回 200 不代表真实收发已通过。

若要先隔离 Zylos 排查，把 `.env` 的 `WSB_MODE` 改成 `echo` 并重启，预期收到 `收到：你发的内容`；完成后切回 `c4` 并重启。

## 在服务器保持运行

正常 `zylos add` 已启动 PM2 服务。使用手动安装方式时，可用附带配置代替前台 `npm start`。先退出正在运行的同一 Channel，避免端口冲突：

```sh
npm run check
pm2 start ecosystem.config.cjs
pm2 logs zylos-wsb
```

修改 `.env` 后执行 `pm2 restart zylos-wsb`。停止使用 `pm2 stop zylos-wsb`。需要随系统启动时，沿用服务器已有的 PM2 启动配置。ngrok 或 HTTPS 反向代理也需要持续运行。

## 不连接 Meta 的本地验证

```sh
npm run demo
npm test
```

`demo` 使用临时 Webhook、模拟 Meta API 和模拟 C4 子进程，验证签名、接收及回复格式。无需凭证，不连接真实 Meta / Zylos，不发送真实消息。

## 范围与排查

- 仅文字收发。图片等事件记录原始信息，不下载附件、不自动回复。
- Channel 本身没有客户白名单；Meta 测试号码仍受平台的测试接收人限制。
- 不做客户身份识别、自动绑定 owner、分配 agent、多客户记忆隔离或管理页面。消息进入当前 Zylos 会话；本包定位是内部演示。
- 普通回复在客户最后一条消息后的 24 小时窗口内使用；窗口外模板发送不在此 Demo 中。
- 重复消息在进程内去重，处理失败返回 503；重启会清空去重记录，失败重试可能留下重复日志。无数据库或持久队列，不承诺恰好处理一次。
- `check` 成功但没有回调：检查公网地址、端口、`messages` 字段订阅、WABA 的 App 订阅和 Phone Number ID。
- `webhook` 提示未找到匹配路由：查看 Zylos 安装输出中的 Caddy 错误，并核对端口；仅执行 `npm run setup` 不会自动配置服务器路由。
- 已收到回调但 Zylos 无回复：确认 `WSB_MODE=c4`、Channel 链接、C4 dispatcher、主会话状态和发送日志。
- Meta 错误 `190`：令牌失效。`131047`：回复窗口关闭。`131030`：测试收件人未加入允许列表。`131031`：账号受限，需在 Meta 侧处理。
- API 超时可能已发送；确认手机是否收到后再重试。Meta 返回消息 ID 代表接受请求，不保证最终送达。
- 单进程运行。更改端口时，ngrok / 反向代理以及 `SKILL.md` 的 route target 都应对应更新。

## 给 Zylos 的回复接口

用入站消息给出的 endpoint 原样回复，保留客户号码和被引用的消息 ID：

```sh
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js wsb '<wa_id>|type:dm|msg:<wamid>' <<'EOF'
回复内容
EOF
```

`scripts/send.js` 支持 C4 的位置参数和 stdin，支持最多 4096 个字符的文字及 `[SKIP]`。客户消息按外部内容处理，不赋予管理员权限。
