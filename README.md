# Telegram 双向私聊机器人（Cloudflare Worker）

一个基于 **Cloudflare Workers** 的 Telegram 双向私聊客服机器人，**无需 Durable Object**，仅依赖 **Workers KV** 即可运行。

用户私聊机器人 → 消息自动转发到超级群组的独立话题；管理员在话题内回复 → 消息回传到用户私聊。内置 **Cloudflare Turnstile** 人机验证、**📬 新消息汇总话题**、通知卡片、封禁 / 结案 / 删除等管理指令。

------

## ✨ 功能特性

- 🔁 **双向私聊**：用户私聊消息 → 转发到超级群组对应话题；管理员回复 → 回传用户私聊
- 🧵 **一人一话题**：自动为用户创建独立 Forum Topic，并发送用户资料卡片（昵称 / ID / 用户名 / 头像）
- 🛡 **人机验证**：基于 Cloudflare Turnstile + Telegram Mini App，有效期内免重复验证（默认 30 天）
- 📬 **新消息汇总**：新消息统一推送到「📬 新消息」话题，附带通知卡片（跳转话题 / 查看资料 / 忽略）
- ⏱ **通知节流**：同一用户短时间内只推一次通知卡片，后续消息优先**编辑旧卡片**，避免刷屏
- ✅ **提示合并**：用户连发多条消息时，「已发送」提示自动合并为「已发送 N 条」（**内存缓存，不占 KV 写额度**）
- 🔗 **关闭链接预览**：转发消息时自动关闭网页预览卡片，话题内保持纯文本观感
- 🚫 **管理指令**：`/ban`、`/unban`、`/close`、`/delete`
- 📎 **多类型媒体**：文本 / 图片 / 视频 / GIF / 语音 / 音频 / 文件 / 贴纸 / 视频消息 / 位置 / 联系人

------

## 📁 项目结构

text

```
.
├── worker.js        # 全部逻辑（单文件，直接粘贴到 Cloudflare Worker 即可）
└── README.md
```



------

## 🚀 部署步骤

### 1. 准备前置条件

| 项目                 | 说明                                                         |
| :------------------- | :----------------------------------------------------------- |
| Cloudflare 账号      | 用于部署 Worker 与创建 KV                                    |
| Telegram Bot         | 通过 [@BotFather](https://t.me/BotFather) 创建，获取 `BOT_TOKEN` |
| 超级群组             | 必须**开启话题（Topics）**功能                               |
| Cloudflare Turnstile | 在 Cloudflare Dashboard 创建站点，获取 Site Key 与 Secret Key |

### 2. 创建 KV 命名空间

进入 **Cloudflare Dashboard → Workers & Pages → KV**，创建一个命名空间（例如 `TOPIC_MAP`）。

### 3. 创建 Worker 并绑定

1. 新建 Worker，将 `worker.js` 内容粘贴进去
2. 在 **Settings → Variables** 中配置环境变量
3. 在 **Settings → KV Namespace Bindings** 中绑定：
   - **Variable name**：`TOPIC_MAP`
   - **KV namespace**：选择刚创建的命名空间
4. 部署 Worker

### 4. 注册 Webhook 与命令菜单

部署完成后，**带上密钥**访问：

text

```
https://<你的 Worker 域名>/registerWebhook?key=<REGISTER_SECRET>
```



看到 `Webhook & Commands Updated - Bot is Active` 即表示成功。

> ⚠️ **必须带 `?key=` 参数**，否则会返回 `Unauthorized`。`REGISTER_SECRET` 请自行设置为一段长随机串。
>
> 💡 建议在 Worker 上配置自定义域名，某些情况下 `workers.dev` 域名在国内访问不稳定。

### 5. 将机器人加入超级群组

1. 把机器人拉进超级群组
2. **设为管理员**，并授予以下权限：
   - ✅ 管理话题（创建 / 编辑 / 关闭 / 删除话题）
   - ✅ 删除消息
3. 确认群组已开启 **Topics（话题）**

------

## ⚙️ 环境变量

### 必填

| 变量名                 | 说明                                             |
| :--------------------- | :----------------------------------------------- |
| `BOT_TOKEN`            | Telegram Bot Token                               |
| `SUPERGROUP_ID`        | 超级群组 ID（形如 `-100xxxxxxxxxx`，需开启话题） |
| `TOPIC_MAP`            | KV 命名空间绑定（**变量名必须是 `TOPIC_MAP`**）  |
| `TURNSTILE_SITE_KEY`   | Turnstile 公开 Site Key                          |
| `TURNSTILE_SECRET_KEY` | Turnstile 私密 Secret Key                        |
| `VERIFY_SECRET`        | 验证链接 HMAC 签名密钥，自拟一段长随机串         |
| `REGISTER_SECRET`      | `/registerWebhook` 接口密钥，防止未授权调用      |

### 可选

| 变量名     | 说明                                                         |
| :--------- | :----------------------------------------------------------- |
| `ADMIN_ID` | 管理员 Telegram 用户 ID。**配置后仅该账号可执行管理指令、接收管理员私聊回复**；不配置则所有群成员均可操作 |

------

## 🛠 使用方法

### 用户侧

1. 私聊机器人，发送 `/start`
2. 点击按钮完成 Cloudflare 人机验证
3. 验证通过后即可直接发送消息（文本、图片、视频、文件等）
4. 消息会自动转发到超级群组中属于自己的话题

### 管理员侧

在用户的专属话题中直接回复即可回传消息给用户。

支持指令：

| 指令      | 说明                                                         |
| :-------- | :----------------------------------------------------------- |
| `/ban`    | 封禁当前话题对应的用户                                       |
| `/unban`  | 解除封禁                                                     |
| `/close`  | 结案：删除通知卡片、重命名话题为 `[已结案] xxx`、关闭话题并清理 KV |
| `/delete` | 彻底删除当前话题及其相关记录                                 |

> 💡 管理员回复用户后，通知卡片会被自动删除，并自动为用户续期验证（剩余不足 2 天时）。

------

## 🔄 工作流程

text

```
用户私聊
   │
   ├─ 未验证 → 发送 Turnstile 验证按钮 → Mini App 验证 → 写入 verifiedUntil
   │
   └─ 已验证 → 确保话题存在 → 转发消息到话题
                              │
                              ├─ 发送用户资料卡片（首次）
                              ├─ 推送「📬 新消息」通知卡片（带节流）
                              └─ 更新「已发送」提示（内存缓存，多条合并）

管理员在话题中回复
   │
   ├─ /ban /unban /close /delete → 执行对应管理操作
   └─ 普通回复 → 删除通知卡片 + 续期 → 转发到用户私聊
```



------

## 🔐 安全设计

- **验证链接签名**：验证 token 使用 HMAC-SHA256 签名，格式为 `userId.exp.sig`，有效期 10 分钟，防伪造
- **签名恒定时间比较**：`timingSafeEqual` 避免 HMAC 比较被短路
- **Token 一次性消费**：验证 token 提交成功后写入 `vt:{token}` 占位，同 token 无法二次消费；Turnstile 校验失败会撤销占位，允许用户重试
- **HTML 转义**：所有用户输入均经过 `escapeHtml`，防止注入
- **内联 JS 安全**：将 token 嵌入 `` 时用 `jsStringLiteral` 转义 `<`，防止 `` 提前闭合
- **registerWebhook 鉴权**：`/registerWebhook` 需要携带正确的 `key` 参数，防止未授权调用
- **本地锁**：`withLocalLock` 保证同一 isolate 内的用户状态读写串行，配合 KV 二次读取降低并发竞态
- **创建占位**：话题创建使用 `topicCreatingUntil` 占位 + 二次确认，避免并发重复创建；若已存在其他话题则自动删除本次创建的
- **删除一致性**：`/delete` 删除话题失败时保留 KV，避免状态与话题不一致
- **孤儿卡片对账**：通知卡片新建前二次读 KV，避免产生重复卡片
- **KV 写重试**：`saveState` 失败时自动重试一次，降低网络抖动影响

------

## 📌 KV 数据结构

| Key                 | 类型   | 说明                                                         |
| :------------------ | :----- | :----------------------------------------------------------- |
| `us:{userId}`       | JSON   | 用户状态（`thread_id`、`sessionId`、`original_name`、`verifiedUntil`、`ban`、`card_id`、`lastNotify` 等） |
| `t:{threadId}`      | String | 话题 → 用户反向映射                                          |
| `sys:todo_id`       | String | 「📬 新消息」汇总话题 ID                                      |
| `sys:todo_creating` | JSON   | 汇总话题创建中的占位标记                                     |
| `vt:{token}`        | String | 验证 token 一次性消费标记（TTL 10 分钟，自动清理）           |

> 💡 「已发送」提示状态存在 **isolate 内存**中，不占用 KV；Worker 冷启动后会丢失，用户可能多看到一条提示，不影响主流程。

------

## ⏱ 关键常量

| 常量                 | 默认值  | 说明                       |
| :------------------- | :------ | :------------------------- |
| `VERIFIED_TTL`       | 30 天   | 人机验证有效期             |
| `NOTIFY_THROTTLE`    | 8 秒    | 同一用户通知卡片节流间隔   |
| `TOPIC_CREATING_TTL` | 15 秒   | 话题创建占位有效期         |
| `VERIFY_LINK_TTL`    | 10 分钟 | 验证链接有效期             |
| `TIP_MERGE_WINDOW`   | 5 秒    | 「已发送」提示合并窗口     |
| `TIP_DELETE_DELAY`   | 3 秒    | 「已发送」提示延迟删除时间 |

可在 `worker.js` 顶部集中调整。

------

## ❓ 常见问题

**Q：管理员收不到用户消息？**
A：检查机器人是否为群管理员、是否开启话题、`SUPERGROUP_ID` 是否正确（应为 `-100` 开头的完整 ID）。

**Q：验证按钮点了没反应？**
A：确认 Worker 域名可正常访问（建议配置自定义域名），并检查 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` 是否填写正确。

**Q：多个用户消息串话题？**
A：确认 KV 绑定变量名严格为 `TOPIC_MAP`。

**Q：能否不用人机验证？**
A：可以。删除 `worker.js` 中「未验证 或 /start：走验证流程」分支即可，但建议保留以防滥用。

**Q：`/registerWebhook` 返回 Unauthorized？**
A：确认访问链接带了 `?key=`，且环境变量 `REGISTER_SECRET` 已设置。

**Q：用户连发多条消息，为什么只看到一条「已发送」提示？**
A：这是**设计行为**。5 秒内的多条消息会合并为「已发送 N 条」一条提示，避免刷屏。

------

## 📄 License

MIT

------

## 🙏 致谢

- [Cloudflare Workers](https://workers.cloudflare.com/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Cloudflare Turnstile](https://developers.cloudflare.com/turnstile/)
