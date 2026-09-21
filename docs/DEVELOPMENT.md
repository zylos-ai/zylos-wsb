# 开发者说明

## 不连接 Meta 的本地验证

```sh
npm run check:syntax   # 语法检查
npm test               # 单元测试
npm run demo           # 端到端本地模拟
```

`demo` 使用临时 Webhook、模拟 Meta API 和模拟 C4 子进程，验证签名、接收及回复格式。
**无需凭证，不连接真实 Meta / Zylos，不发送真实消息。**

这三条都不依赖任何环境变量。测试用例断言的是 `realpathSync` 规范化之后的真实路径，
因此在 `/tmp` 是软链的机器上也能直接跑——**不需要设置 `TMPDIR`**。

## CI

`.github/workflows/ci.yml` 在 push 到 `main` 和针对 `main` 的 PR 上运行，
矩阵为 Node `20.20.0`（`engines` 声明的下限）和 `22.x`：

1. 断言仓库仍然零依赖（见下）
2. `npm run check:syntax`
3. `npm test`
4. `npm run demo`
5. `npm pack --dry-run`
6. 断言打包产物不含 `.env`、`data/` 或日志

## 零依赖是一条约束，不是巧合

本 Channel 没有任何运行时依赖，因此仓库里**没有 lockfile**，CI 也不执行 `npm install`。

CI 会主动拦截「加了依赖却没有 lockfile」的情况。如果确实需要引入依赖：
先提交 `package-lock.json`，再把 CI 改成 `npm ci`，最后移除那条断言。
否则 CI 与生产环境会在无人察觉的情况下跑在不同的依赖版本上。

## 范围与限制

明确边界，避免把「演示可用」读成「生产能力」：

- 仅文字收发。图片等事件记录原始信息，**不下载附件、不自动回复**。
- Channel 本身**没有客户白名单**；Meta 测试号码仍受平台的测试接收人限制。
- 不做客户身份识别、自动绑定 owner、分配 agent、多客户记忆隔离或管理页面。
  消息进入当前 Zylos 会话；本包定位是**内部演示**。
- 普通回复只能在客户最后一条消息后的 **24 小时窗口**内使用；窗口外的模板发送不在本 Demo 中。
- 无数据库或持久队列，**不承诺恰好处理一次**（exactly-once）。
- 单进程运行。

客户数据的落盘范围、保留策略和清理方式见 [DATA.md](DATA.md)。

## 给 Zylos 的回复接口

用入站消息给出的 endpoint 原样回复，保留客户号码和被引用的消息 ID：

```sh
node ~/zylos/.claude/skills/comm-bridge/scripts/c4-send.js wsb '<wa_id>|type:dm|msg:<wamid>' <<'EOF'
回复内容
EOF
```

`scripts/send.js` 支持 C4 的位置参数和 stdin，支持最多 4096 个字符的文字及 `[SKIP]`。
客户消息按**外部内容**处理，不赋予管理员权限。
