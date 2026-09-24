// ============================================================
// Telegram 双向私聊机器人
// Cloudflare Worker（无 Durable Object）
//
// 功能概述：
//   1. 用户私聊消息 → 转发到超级群组对应话题
//   2. 管理员在话题中回复 → 回传到用户私聊
//   3. Cloudflare Turnstile 人机验证（Telegram Mini App）
//   4. 新消息汇总话题（📬 新消息）+ 通知卡片
//   5. 管理员指令：/ban /unban /close /delete
//
// 环境变量（必填）：
//   BOT_TOKEN              - Telegram Bot Token
//   SUPERGROUP_ID          - 超级群组 ID（需开启话题）
//   TOPIC_MAP              - KV 命名空间绑定
//   TURNSTILE_SITE_KEY     - Turnstile 公开 Site Key
//   TURNSTILE_SECRET_KEY   - Turnstile 私密 Secret Key
//   VERIFY_SECRET          - 验证链接签名密钥（自拟长随机串）
//
// 环境变量（可选）：
//   ADMIN_ID               - 管理员 Telegram 用户 ID
//   CLEANUP_SECRET         - /cleanup 接口密钥
// ============================================================

// ============================================================
// 1. 对外提示文案（集中管理，方便修改）
// ============================================================
const MSG = {
  ban: "🚫 <b>您已被管理员禁止咨询。</b>",
  success: "✅ <b>验证通过</b>\n\n您可以开始发送消息了。",
  verified: "✅ <b>您已经验证过了。</b>\n\n验证有效期内可以直接发送消息。",
  noCmd: "ℹ️ 暂不支持该指令。",
  closed: "✅ <b>本次咨询已结束。</b>\n\n如需再次咨询，请发送 /start。",
  banned: "🚫 <b>已封禁该用户。</b>",
  unbanned: "✅ <b>已解除该用户封禁。</b>",
  closedAdmin: "✅ <b>该咨询已结案。</b>",
  deleted: "🗑️ <b>正在彻底删除该咨询话题及相关记录。</b>",
  deletedUser: "🗑️ <b>本次咨询记录正在删除。</b>",
  adminStart: "🤖 <b>客服机器人运行正常。</b>",
  adminHelp:
    "📖 <b>管理员指令</b>\n\n" +
    "/ban - 封禁当前用户\n" +
    "/unban - 解除封禁\n" +
    "/close - 关闭当前咨询\n" +
    "/delete - 删除当前咨询话题",
  adminNoMsg: "⚠️ 当前话题没有绑定用户。",
  cfNeed:
    "🛡 <b>人机验证</b>\n\n" +
    "为了防止机器人滥用，请先完成 Cloudflare 人机验证。\n\n" +
    "点击下方按钮，在弹窗中完成验证即可。",
  cfSuccessBot: "✅ <b>人机验证通过！</b>\n\n您现在可以开始发送消息了。"
};

// ============================================================
// 2. KV 键名生成（统一管理，避免硬编码）
// ============================================================
const KEY = {
  /** 用户状态：us:{userId} */
  user: id => `us:${id}`,
  /** 话题 → 用户反向映射：t:{threadId} */
  thread: id => `t:${id}`,
  /** 📬 新消息汇总话题 ID */
  todoId: "sys:todo_id",
  /** 汇总话题创建中占位标记 */
  todoCreating: "sys:todo_creating"
};

// ============================================================
// 3. 时间常量（单位：秒）
// ============================================================
const VERIFIED_TTL = 30 * 24 * 3600; // 人机验证有效期：30 天
const TIP_TTL = 60;                  // 「已发送」提示相关（预留）
const NOTIFY_THROTTLE = 8;           // 通知卡片节流间隔
const TOPIC_CREATING_TTL = 15;       // 话题创建占位有效期
const VERIFY_LINK_TTL = 600;         // 验证链接有效期：10 分钟

// ============================================================
// 4. 通用工具函数
// ============================================================

/** 同一 isolate 内的内存锁（Promise 链排队） */
const LOCAL_LOCKS = new Map();

/** 休眠指定毫秒 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 当前 Unix 时间戳（秒） */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** HTML 转义，防止注入 */
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ArrayBuffer → base64url */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HMAC-SHA256 签名（用于验证链接防伪造） */
async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );
  return bufToBase64Url(sig);
}

/**
 * 生成带过期时间的验证 token
 * 格式：userId.过期时间戳.签名
 */
async function createVerifyToken(userId, env) {
  const exp = nowSec() + VERIFY_LINK_TTL;
  const payload = `${userId}.${exp}`;
  const sig = await hmacSign(env.VERIFY_SECRET, payload);
  return `${payload}.${sig}`;
}

/**
 * 解析并校验验证 token
 * @returns {string|null} 合法则返回 userId，否则 null
 */
async function parseVerifyToken(token, env) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [userId, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!userId || !exp || exp < nowSec()) return null;

    const payload = `${userId}.${exp}`;
    const expected = await hmacSign(env.VERIFY_SECRET, payload);
    if (sig !== expected) return null;
    return userId;
  } catch {
    return null;
  }
}

/**
 * 带本地锁执行异步函数（同 isolate 内串行）
 * 注意：不同 isolate 之间仍可能并发，关键路径需结合 KV 二次确认
 */
async function withLocalLock(key, fn) {
  const previous = LOCAL_LOCKS.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const chain = previous.catch(() => {}).then(() => current);
  LOCAL_LOCKS.set(key, chain);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (LOCAL_LOCKS.get(key) === chain) {
      LOCAL_LOCKS.delete(key);
    }
  }
}

// ============================================================
// 5. 用户状态读写（KV）
// ============================================================

/** 读取用户状态，不存在则返回空对象 */
async function getState(env, uid) {
  return (await env.TOPIC_MAP.get(KEY.user(uid), { type: "json" })) || {};
}

/**
 * 保存用户状态
 * 自动清理已过期的 verifiedUntil
 */
async function saveState(env, uid, state) {
  const copy = { ...state };
  const now = nowSec();
  if (copy.verifiedUntil && copy.verifiedUntil <= now) {
    delete copy.verifiedUntil;
  }
  await env.TOPIC_MAP.put(KEY.user(uid), JSON.stringify(copy));
  return copy;
}

// ============================================================
// 6. 主入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin; // 用于生成验证链接

    // ---------- 人机验证页面（GET 展示 / POST 提交） ----------
    if (url.pathname === "/cf-verify") {
      if (request.method === "GET") return handleCfVerifyPage(request, env);
      if (request.method === "POST") return handleCfVerifySubmit(request, env, ctx);
    }

    // ---------- 注册 Webhook 与命令菜单 ----------
    if (url.pathname === "/registerWebhook") {
      return handleRegisterWebhook(request, env);
    }

    // ---------- 清理旧版 KV 数据 ----------
    if (url.pathname === "/cleanup") {
      return handleCleanup(request, env);
    }

    // 只处理 Telegram Webhook 的 POST
    if (request.method !== "POST") {
      return new Response("OK");
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // 回调查询（忽略通知卡片等）
    if (update.callback_query) {
      ctx.waitUntil(handleCallback(update.callback_query, env));
      return new Response("OK");
    }

    const msg = update.message;
    if (!msg) return new Response("OK");

    // 用户私聊
    if (msg.chat?.type === "private") {
      ctx.waitUntil(handlePrivate(msg, env, ctx, origin));
      return new Response("OK");
    }

    // 超级群组话题消息（管理员回复）
    if (
      msg.chat?.id != null &&
      String(msg.chat.id) === String(env.SUPERGROUP_ID) &&
      msg.message_thread_id
    ) {
      ctx.waitUntil(handleAdminReply(msg, env, ctx));
      return new Response("OK");
    }

    return new Response("OK");
  }
};

// ============================================================
// 7. 处理用户私聊消息
// ============================================================
async function handlePrivate(msg, env, ctx, origin) {
  const user = msg.from;
  if (!user) return;

  const userId = user.id;
  let state = await getState(env, userId);
  const now = nowSec();

  // ---------- 管理员私聊：仅响应 /start ----------
  if (env.ADMIN_ID && String(userId) === String(env.ADMIN_ID)) {
    if (msg.text === "/start") {
      return tgCall(env, "sendMessage", {
        chat_id: userId,
        text: MSG.adminStart,
        parse_mode: "HTML"
      });
    }
    return;
  }

  // ---------- 永久封禁 ----------
  if (state.ban) {
    return tgCall(env, "sendMessage", {
      chat_id: userId,
      text: MSG.ban,
      parse_mode: "HTML"
    });
  }

  // ---------- 未验证 或 /start：走验证流程 ----------
  if (msg.text === "/start" || !state.verifiedUntil || state.verifiedUntil <= now) {
    // 已在有效期内
    if (state.verifiedUntil && state.verifiedUntil > now) {
      return tgCall(env, "sendMessage", {
        chat_id: userId,
        text: MSG.verified,
        parse_mode: "HTML"
      });
    }
    // 发送 Mini App 验证按钮
    return sendCfChallenge(userId, env, origin);
  }

  // ---------- 已验证：确保话题存在并转发消息 ----------
  const topic = await ensureUserTopic(msg, env);
  if (!topic) return;

  state = topic.state;
  const threadId = topic.threadId;
  const sessionId = state.sessionId;

  // 媒体组稍作延迟，降低顺序错乱概率
  if (msg.media_group_id) {
    await sleep(300 + Math.floor(Math.random() * 700));
  }

  // 再次读取最新状态，防止 /close /delete 期间状态已变
  const latest = await getState(env, userId);
  if (!latest.thread_id || String(latest.thread_id) !== String(threadId)) return;
  if (sessionId && latest.sessionId && sessionId !== latest.sessionId) return;
  if (latest.ban) return;

  // 转发到超级群组话题
  const sent = await sendBot(msg, env.SUPERGROUP_ID, threadId, env);
  if (!sent?.ok) return;

  // 异步触发「新消息」通知卡片
  ctx.waitUntil(
    triggerNotification(user, threadId, env, getPreview(msg), sent.result?.message_id)
  );

  // 给用户发送「已发送」提示，2 秒后自动删除
  await withLocalLock(`user-state:${userId}`, async () => {
    const current = await getState(env, userId);
    if (!current.thread_id || String(current.thread_id) !== String(threadId)) return;

    const tipRes = await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "✅ <b>已发送</b>",
      parse_mode: "HTML"
    });

    if (tipRes.ok) {
      ctx.waitUntil(
        (async () => {
          await sleep(2000);
          await tgCall(env, "deleteMessage", {
            chat_id: userId,
            message_id: tipRes.result.message_id
          });
        })()
      );
    }
  });
}

// ============================================================
// 8. 发送人机验证按钮（Telegram Mini App）
// ============================================================
async function sendCfChallenge(userId, env, origin) {
  const token = await createVerifyToken(userId, env);
  const verifyUrl = `${origin}/cf-verify?token=${encodeURIComponent(token)}`;

  return tgCall(env, "sendMessage", {
    chat_id: userId,
    text: MSG.cfNeed,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        // web_app：在 Telegram 内打开，不跳外部浏览器
        [{ text: "🛡 点击完成人机验证", web_app: { url: verifyUrl } }]
      ]
    }
  });
}

// ============================================================
// 9. 验证页面 GET（Mini App 内展示 Turnstile）
// ============================================================
async function handleCfVerifyPage(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";

  const userId = await parseVerifyToken(token, env);
  if (!userId) {
    // token 无效或过期
    return new Response(
      `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>验证失败</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    body { font-family: system-ui; text-align: center; padding: 40px 20px; background: #f5f5f5; }
  </style>
</head>
<body>
  <h2>⚠️ 链接无效或已过期</h2>
  <p>请返回机器人重新发送 /start 获取新链接</p>
  <script>
    if (window.Telegram && Telegram.WebApp) {
      Telegram.WebApp.ready();
      Telegram.WebApp.expand();
    }
  </script>
</body>
</html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } }
    );
  }

  const siteKey = env.TURNSTILE_SITE_KEY || "";

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>人机验证</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--tg-theme-bg-color, #f5f5f5);
      color: var(--tg-theme-text-color, #1a1a2e);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: var(--tg-theme-secondary-bg-color, #fff);
      border-radius: 16px;
      padding: 32px 24px;
      max-width: 400px;
      width: 100%;
      box-shadow: 0 8px 30px rgba(0,0,0,0.08);
      text-align: center;
    }
    h1 { font-size: 20px; margin-bottom: 8px; }
    p { font-size: 14px; opacity: 0.7; margin-bottom: 24px; line-height: 1.5; }
    .widget { display: flex; justify-content: center; margin: 20px 0; min-height: 65px; }
    .status { margin-top: 16px; font-size: 14px; min-height: 24px; }
    .success { color: #16a34a; font-weight: 600; }
    .error { color: #dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🛡 人机验证</h1>
    <p>请完成下方验证，通过后即可返回继续咨询</p>
    <div class="widget">
      <div class="cf-turnstile"
           data-sitekey="${escapeHtml(siteKey)}"
           data-callback="onSuccess"
           data-error-callback="onError"
           data-theme="auto"></div>
    </div>
    <div class="status" id="status"></div>
  </div>

  <script>
    const token = ${JSON.stringify(token)};

    // 初始化 Telegram Mini App
    if (window.Telegram && Telegram.WebApp) {
      Telegram.WebApp.ready();
      Telegram.WebApp.expand();
    }

    // Turnstile 验证成功回调
    async function onSuccess(turnstileToken) {
      const status = document.getElementById("status");
      status.textContent = "正在验证…";
      status.className = "status";

      try {
        const res = await fetch("/cf-verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token, turnstileToken })
        });
        const data = await res.json();
        if (data.ok) {
          status.textContent = "✅ 验证成功！即将关闭…";
          status.className = "status success";
          // 约 1.2 秒后自动关闭 Mini App
          setTimeout(() => {
            if (window.Telegram && Telegram.WebApp) {
              Telegram.WebApp.close();
            }
          }, 1200);
        } else {
          status.textContent = "❌ " + (data.error || "验证失败，请重试");
          status.className = "status error";
        }
      } catch (e) {
        status.textContent = "❌ 网络错误，请稍后重试";
        status.className = "status error";
      }
    }

    function onError() {
      document.getElementById("status").textContent = "验证组件加载失败，请关闭后重试";
      document.getElementById("status").className = "status error";
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

// ============================================================
// 10. 验证页面 POST（校验 Turnstile 并写入用户状态）
// ============================================================
async function handleCfVerifySubmit(request, env, ctx) {
  try {
    const body = await request.json();
    const { token, turnstileToken } = body || {};

    if (!token || !turnstileToken) {
      return json({ ok: false, error: "参数缺失" });
    }

    // 校验签名 token，取出 userId
    const userId = await parseVerifyToken(token, env);
    if (!userId) {
      return json({ ok: false, error: "链接无效或已过期" });
    }

    // 向 Cloudflare 校验 Turnstile token
    const formData = new FormData();
    formData.append("secret", env.TURNSTILE_SECRET_KEY);
    formData.append("response", turnstileToken);
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) formData.append("remoteip", ip);

    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: formData }
    );
    const outcome = await verifyRes.json();

    if (!outcome.success) {
      console.error("Turnstile failed", outcome);
      return json({ ok: false, error: "人机验证未通过" });
    }

    // 写入验证通过状态（加锁防并发覆盖）
    await withLocalLock(`user-state:${userId}`, async () => {
      const state = await getState(env, userId);
      state.verifiedUntil = nowSec() + VERIFIED_TTL;
      await saveState(env, userId, state);
    });

    // 主动通知用户验证成功
    ctx.waitUntil(
      tgCall(env, "sendMessage", {
        chat_id: userId,
        text: MSG.cfSuccessBot,
        parse_mode: "HTML"
      })
    );

    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: "服务器错误" });
  }
}

/** 返回 JSON 响应 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// ============================================================
// 11. 确保用户话题存在（创建占位 + 二次确认，降低重复创建）
// ============================================================
async function ensureUserTopic(msg, env) {
  const user = msg.from;
  const userId = user.id;

  return withLocalLock(`user-topic:${userId}`, async () => {
    let state = await getState(env, userId);

    // 已有话题，直接返回
    if (state.thread_id) {
      return { threadId: String(state.thread_id), state };
    }

    // 其他请求正在创建：短暂等待
    if (state.topicCreatingUntil && state.topicCreatingUntil > nowSec()) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await sleep(300);
        state = await getState(env, userId);
        if (state.thread_id) {
          return { threadId: String(state.thread_id), state };
        }
        if (!state.topicCreatingUntil || state.topicCreatingUntil <= nowSec()) break;
      }
    }

    state = await getState(env, userId);
    if (state.thread_id) {
      return { threadId: String(state.thread_id), state };
    }

    // 写入创建占位
    const creatingToken = crypto.randomUUID();
    state.topicCreatingUntil = nowSec() + 15;
    state.topicCreatingToken = creatingToken;
    await saveState(env, userId, state);

    const displayName =
      [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "用户";
    const topicName = displayName.substring(0, 120);

    // 调用 Telegram 创建 Forum Topic
    const res = await tgCall(env, "createForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      name: topicName
    });

    // 创建失败：清理自己的占位
    if (!res.ok || !res.result?.message_thread_id) {
      const latest = await getState(env, userId);
      if (latest.topicCreatingToken === creatingToken) {
        delete latest.topicCreatingUntil;
        delete latest.topicCreatingToken;
        await saveState(env, userId, latest);
      }
      return null;
    }

    const newThreadId = String(res.result.message_thread_id);
    state = await getState(env, userId);

    // 并发下已有其他话题：删除本次创建的话题
    if (state.thread_id && String(state.thread_id) !== newThreadId) {
      await tgCall(env, "deleteForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(newThreadId)
      });
      return { threadId: String(state.thread_id), state };
    }

    // 建立新会话
    const sessionId = crypto.randomUUID();
    state.thread_id = newThreadId;
    state.sessionId = sessionId;
    state.original_name = topicName;
    delete state.topicCreatingUntil;
    delete state.topicCreatingToken;
    await saveState(env, userId, state);

    // 反向映射：话题 → 用户
    await env.TOPIC_MAP.put(KEY.thread(newThreadId), String(userId));

    // 发送用户资料卡片到话题
    await sendUserProfileCard(user, newThreadId, env, topicName);

    return { threadId: newThreadId, state };
  });
}

// ============================================================
// 12. 发送用户资料卡片到话题
// ============================================================
async function sendUserProfileCard(user, threadId, env, originalName = "") {
  const chatId = env.SUPERGROUP_ID;
  const displayName =
    [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "用户";
  const username = user.username ? `@${user.username}` : "无";
  const userId = user.id;

  let text = "📇 <b>用户资料卡片</b>\n\n";
  text += `👤 <b>昵称</b>: ${escapeHtml(displayName)}\n`;
  text += `🆔 <b>ID</b>: <code>${userId}</code>\n`;
  text += `🔗 <b>账号</b>: ${escapeHtml(username)}\n`;
  text += `💬 <b>话题名</b>: ${escapeHtml(originalName)}\n`;

  // 尝试获取头像
  let photoId = null;
  try {
    const res = await tgCall(env, "getUserProfilePhotos", {
      user_id: userId,
      limit: 1
    });
    if (res.ok && res.result?.total_count > 0) {
      const sizes = res.result.photos[0];
      photoId = sizes[sizes.length - 1].file_id;
    }
  } catch {}

  if (photoId) {
    await tgCall(env, "sendPhoto", {
      chat_id: chatId,
      message_thread_id: Number(threadId),
      photo: photoId,
      caption: text,
      parse_mode: "HTML"
    });
  } else {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      message_thread_id: Number(threadId),
      text,
      parse_mode: "HTML"
    });
  }
}

// ============================================================
// 13. 确保「📬 新消息」汇总话题存在
// ============================================================
async function ensureTodoTopic(env) {
  return withLocalLock(`todo-topic:${env.SUPERGROUP_ID}`, async () => {
    let todoId = await env.TOPIC_MAP.get(KEY.todoId);
    if (todoId) return String(todoId);

    // 创建中：短暂等待
    let creating = await env.TOPIC_MAP.get(KEY.todoCreating, { type: "json" });
    if (creating && creating.until && creating.until > nowSec()) {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        await sleep(300);
        todoId = await env.TOPIC_MAP.get(KEY.todoId);
        if (todoId) return String(todoId);
        creating = await env.TOPIC_MAP.get(KEY.todoCreating, { type: "json" });
        if (!creating || !creating.until || creating.until <= nowSec()) break;
      }
    }

    todoId = await env.TOPIC_MAP.get(KEY.todoId);
    if (todoId) return String(todoId);

    // 写入创建占位
    const token = crypto.randomUUID();
    await env.TOPIC_MAP.put(
      KEY.todoCreating,
      JSON.stringify({ until: nowSec() + TOPIC_CREATING_TTL, id: token })
    );

    const res = await tgCall(env, "createForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      name: "📬 新消息"
    });

    if (!res.ok || !res.result?.message_thread_id) {
      const latest = await env.TOPIC_MAP.get(KEY.todoCreating, { type: "json" });
      if (latest?.id === token) await env.TOPIC_MAP.delete(KEY.todoCreating);
      return null;
    }

    const newTodoId = String(res.result.message_thread_id);
    todoId = await env.TOPIC_MAP.get(KEY.todoId);

    // 已有其他汇总话题：删除本次创建的
    if (todoId && String(todoId) !== newTodoId) {
      await tgCall(env, "deleteForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(newTodoId)
      });
      return String(todoId);
    }

    await env.TOPIC_MAP.put(KEY.todoId, newTodoId);
    const latest = await env.TOPIC_MAP.get(KEY.todoCreating, { type: "json" });
    if (latest?.id === token) await env.TOPIC_MAP.delete(KEY.todoCreating);

    return newTodoId;
  });
}

// ============================================================
// 14. 触发新消息通知卡片（带节流，优先编辑旧卡片）
// ============================================================
async function triggerNotification(from, userThreadId, env, preview, lastId) {
  const userId = from.id;

  return withLocalLock(`notify:${env.SUPERGROUP_ID}`, async () => {
    let state = await getState(env, userId);
    if (!state.thread_id || String(state.thread_id) !== String(userThreadId)) return;

    const sessionId = state.sessionId;
    const now = nowSec();

    // 短时间内不重复通知
    if (state.lastNotify && now - state.lastNotify < NOTIFY_THROTTLE) return;

    let todoId = await ensureTodoTopic(env);
    if (!todoId) return;

    const name =
      [from.first_name, from.last_name].filter(Boolean).join(" ").trim() || "用户";
    const safeName = escapeHtml(name);
    const safePreview = escapeHtml(preview);

    let text = "🎯 <b>新消息提醒</b>\n\n";
    text += `👤 <b>用户</b>: ${safeName}\n`;
    if (from.username) {
      text += `🆔 <b>账号</b>: @${escapeHtml(from.username)}\n`;
    } else {
      text += `🆔 <b>ID</b>: <code>${userId}</code>\n`;
    }
    text += `💬 <b>内容</b>: ${safePreview}\n\n`;

    const cardId = state.card_id;
    if (cardId) {
      text += "🔔 状态: [追加消息]";
    } else {
      const adminMention = env.ADMIN_ID
        ? `<a href="tg://user?id=${env.ADMIN_ID}">@管理员</a>`
        : "<b>管理员</b>";
      text += `📢 呼叫 ${adminMention} [待处理]`;
    }

    // 跳转链接（超级群组）
    const cleanId = String(env.SUPERGROUP_ID).replace("-100", "");
    const jumpUrl = `https://t.me/c/${cleanId}/${lastId}?thread=${userThreadId}`;

    const kb = {
      inline_keyboard: [
        [
          { text: "🚀 跳转话题", url: jumpUrl },
          ...(from.username
            ? [{ text: "👤 资料", url: `https://t.me/${from.username}` }]
            : [])
        ],
        [{ text: "🗑️ 忽略卡片", callback_data: `del:${userId}` }]
      ]
    };

    // 优先尝试编辑已有卡片
    if (cardId) {
      const edit = await tgCall(env, "editMessageText", {
        chat_id: env.SUPERGROUP_ID,
        message_id: Number(cardId),
        text,
        parse_mode: "HTML",
        reply_markup: kb
      });
      if (edit.ok) {
        await withLocalLock(`user-state:${userId}`, async () => {
          const latest = await getState(env, userId);
          if (!latest.thread_id || String(latest.thread_id) !== String(userThreadId)) return;
          if (sessionId && latest.sessionId && sessionId !== latest.sessionId) return;
          latest.lastNotify = now;
          await saveState(env, userId, latest);
        });
        return;
      }
      // 编辑失败（卡片可能已删）：清理状态后新建
      await withLocalLock(`user-state:${userId}`, async () => {
        const latest = await getState(env, userId);
        if (String(latest.thread_id) !== String(userThreadId)) return;
        delete latest.card_id;
        delete latest.lastNotify;
        await saveState(env, userId, latest);
      });
    }

    // 创建新通知卡片
    let res = await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: Number(todoId),
      text,
      parse_mode: "HTML",
      reply_markup: kb
    });

    // 汇总话题可能被删：重建后再发一次
    if (!res.ok) {
      const currentTodo = await env.TOPIC_MAP.get(KEY.todoId);
      if (currentTodo && String(currentTodo) === String(todoId)) {
        await env.TOPIC_MAP.delete(KEY.todoId);
      }
      todoId = await ensureTodoTopic(env);
      if (!todoId) return;
      res = await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(todoId),
        text,
        parse_mode: "HTML",
        reply_markup: kb
      });
    }

    if (!res.ok) return;

    // 保存新卡片 ID
    await withLocalLock(`user-state:${userId}`, async () => {
      const latest = await getState(env, userId);
      if (!latest.thread_id || String(latest.thread_id) !== String(userThreadId)) return;
      if (sessionId && latest.sessionId && sessionId !== latest.sessionId) return;
      latest.card_id = String(res.result.message_id);
      latest.lastNotify = now;
      await saveState(env, userId, latest);
    });
  });
}

// ============================================================
// 15. 处理管理员在话题中的回复
// ============================================================
async function handleAdminReply(msg, env, ctx) {
  const tid = String(msg.message_thread_id);

  // 忽略汇总话题本身
  const todoId = await env.TOPIC_MAP.get(KEY.todoId);
  if (todoId && String(tid) === String(todoId)) return;

  // 查找话题绑定的用户
  const uid = await env.TOPIC_MAP.get(KEY.thread(tid));
  if (!uid) return;

  // 权限：未配置 ADMIN_ID 则所有人可操作；配置了则仅管理员
  const isAdmin = !env.ADMIN_ID || String(msg.from?.id) === String(env.ADMIN_ID);
  if (!isAdmin) return;

  const cmd = msg.text?.trim() || "";

  // ---------- /ban 封禁 ----------
  if (/^\/ban\b/.test(cmd)) {
    return withLocalLock(`user-state:${uid}`, async () => {
      const state = await getState(env, uid);
      state.ban = true;
      await saveState(env, uid, state);
      return tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid),
        text: MSG.banned,
        parse_mode: "HTML"
      });
    });
  }

  // ---------- /unban 解封 ----------
  if (/^\/unban\b/.test(cmd)) {
    return withLocalLock(`user-state:${uid}`, async () => {
      const state = await getState(env, uid);
      delete state.ban;
      await saveState(env, uid, state);
      return tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid),
        text: MSG.unbanned,
        parse_mode: "HTML"
      });
    });
  }

  // ---------- /close 结案（关闭话题并清理 KV） ----------
  if (/^\/close\b/.test(cmd)) {
    return withLocalLock(`user-state:${uid}`, async () => {
      const state = await getState(env, uid);
      const name = state.original_name || uid;

      if (state.card_id) {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: Number(state.card_id)
        });
      }

      await tgCall(env, "editForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid),
        name: `[已结案] ${name}`.substring(0, 60)
      });

      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid),
        text: MSG.closedAdmin,
        parse_mode: "HTML"
      });

      const closeRes = await tgCall(env, "closeForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid)
      });

      if (!closeRes.ok) {
        await tgCall(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: Number(tid),
          text: `⚠️ <b>关闭话题失败</b>\n\n${escapeHtml(closeRes.description || "未知错误")}`,
          parse_mode: "HTML"
        });
        return;
      }

      await Promise.all([
        env.TOPIC_MAP.delete(KEY.user(uid)),
        env.TOPIC_MAP.delete(KEY.thread(tid))
      ]);

      await tgCall(env, "sendMessage", {
        chat_id: uid,
        text: MSG.closed,
        parse_mode: "HTML"
      });
    });
  }

  // ---------- /delete 彻底删除话题 ----------
  if (/^\/delete\b/.test(cmd)) {
    return withLocalLock(`user-state:${uid}`, async () => {
      const state = await getState(env, uid);

      if (state.card_id) {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: Number(state.card_id)
        });
      }

      await tgCall(env, "sendMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid),
        text: MSG.deleted,
        parse_mode: "HTML"
      });

      const delRes = await tgCall(env, "deleteForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid)
      });

      // 删除失败则保留 KV，避免状态与话题不一致
      if (!delRes.ok) {
        await tgCall(env, "sendMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_thread_id: Number(tid),
          text:
            `⚠️ <b>删除话题失败</b>\n` +
            `原因：${escapeHtml(delRes.description || "未知错误")}\n\n` +
            `请检查机器人是否拥有「删除消息」权限。`,
          parse_mode: "HTML"
        });
        return;
      }

      await Promise.all([
        env.TOPIC_MAP.delete(KEY.user(uid)),
        env.TOPIC_MAP.delete(KEY.thread(tid))
      ]);

      await tgCall(env, "sendMessage", {
        chat_id: uid,
        text: MSG.deletedUser,
        parse_mode: "HTML"
      });
    });
  }

  // ---------- 其他以 / 开头的指令 ----------
  if (/^\//.test(cmd)) {
    return tgCall(env, "sendMessage", {
      chat_id: uid,
      text: MSG.noCmd,
      parse_mode: "HTML"
    });
  }

  // ---------- 普通管理员回复：清除通知卡片并转发 ----------
  await withLocalLock(`user-state:${uid}`, async () => {
    const state = await getState(env, uid);
    if (state.card_id) {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: Number(state.card_id)
      });
      delete state.card_id;
      delete state.lastNotify;
    }
    // 剩余有效期不足 2 天时自动续期
    const now = nowSec();
    if (!state.verifiedUntil || state.verifiedUntil < now + 2 * 24 * 3600) {
      state.verifiedUntil = now + VERIFIED_TTL;
    }
    await saveState(env, uid, state);
  });

  await sendBot(msg, uid, null, env);
}

// ============================================================
// 16. 通用消息转发（支持多种媒体类型）
// ============================================================
async function sendBot(msg, target, thread, env) {
  const base = { chat_id: target };
  if (thread) base.message_thread_id = Number(thread);

  if (msg.text) {
    const body = { ...base, text: msg.text };
    if (msg.entities) body.entities = msg.entities;
    return tgCall(env, "sendMessage", body);
  }
  if (msg.photo) {
    const body = {
      ...base,
      photo: msg.photo[msg.photo.length - 1].file_id,
      caption: msg.caption
    };
    if (msg.caption_entities) body.caption_entities = msg.caption_entities;
    return tgCall(env, "sendPhoto", body);
  }
  if (msg.video) {
    const body = {
      ...base,
      video: msg.video.file_id,
      caption: msg.caption
    };
    if (msg.caption_entities) body.caption_entities = msg.caption_entities;
    return tgCall(env, "sendVideo", body);
  }
  if (msg.animation) {
    const body = {
      ...base,
      animation: msg.animation.file_id,
      caption: msg.caption
    };
    if (msg.caption_entities) body.caption_entities = msg.caption_entities;
    return tgCall(env, "sendAnimation", body);
  }
  if (msg.video_note) {
    return tgCall(env, "sendVideoNote", {
      ...base,
      video_note: msg.video_note.file_id
    });
  }
  if (msg.sticker) {
    return tgCall(env, "sendSticker", {
      ...base,
      sticker: msg.sticker.file_id
    });
  }
  if (msg.voice) {
    return tgCall(env, "sendVoice", {
      ...base,
      voice: msg.voice.file_id,
      caption: msg.caption
    });
  }
  if (msg.audio) {
    return tgCall(env, "sendAudio", {
      ...base,
      audio: msg.audio.file_id,
      caption: msg.caption,
      caption_entities: msg.caption_entities
    });
  }
  if (msg.document) {
    return tgCall(env, "sendDocument", {
      ...base,
      document: msg.document.file_id,
      caption: msg.caption,
      caption_entities: msg.caption_entities
    });
  }
  if (msg.location) {
    return tgCall(env, "sendLocation", {
      ...base,
      latitude: msg.location.latitude,
      longitude: msg.location.longitude
    });
  }
  if (msg.contact) {
    return tgCall(env, "sendContact", {
      ...base,
      phone_number: msg.contact.phone_number,
      first_name: msg.contact.first_name,
      last_name: msg.contact.last_name
    });
  }
  return { ok: false };
}

// ============================================================
// 17. 处理回调查询（目前仅「忽略通知卡片」）
// ============================================================
async function handleCallback(query, env) {
  const data = query.data || "";
  const userId = query.from.id;

  if (data.startsWith("del:")) {
    const targetUid = data.substring(4);
    const isAdmin = !env.ADMIN_ID || String(userId) === String(env.ADMIN_ID);
    if (!isAdmin) {
      await tgCall(env, "answerCallbackQuery", {
        callback_query_id: query.id,
        text: "无权限",
        show_alert: true
      });
      return;
    }

    await withLocalLock(`user-state:${targetUid}`, async () => {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: query.message.message_id
      });
      const state = await getState(env, targetUid);
      delete state.card_id;
      delete state.lastNotify;
      await saveState(env, targetUid, state);
    });

    await tgCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      text: "已忽略"
    });
  }
}

// ============================================================
// 18. 生成消息预览（用于通知卡片）
// ============================================================
function getPreview(msg) {
  if (!msg) return "[未知消息]";
  if (msg.text) return msg.text.substring(0, 30);
  if (msg.sticker) return "📌 发送了贴纸 " + (msg.sticker.emoji || "");
  if (msg.photo) return "🖼️ [图片消息]";
  if (msg.video) return "🎬 [视频消息]";
  if (msg.video_note) return "🎥 [视频消息]";
  if (msg.animation) return "🎞️ [动画/GIF]";
  if (msg.voice) return "🎤 [语音消息]";
  if (msg.audio) return "🎵 [音频文件]";
  if (msg.document) {
    return "📄 [文件: " + (msg.document.file_name || "未知") + "]";
  }
  if (msg.location) return "📍 [位置消息]";
  if (msg.venue) return "📍 [地点消息]";
  if (msg.contact) return "📇 [联系人消息]";
  if (msg.poll) return "🗳️ [投票消息]";
  return "[媒体消息]";
}

// ============================================================
// 19. 注册 Webhook 与命令菜单
// ============================================================
async function handleRegisterWebhook(request, env) {
  const domain = `https://${new URL(request.url).hostname}`;
  const webhook = await tgCall(env, "setWebhook", {
    url: domain,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });

  // 私聊命令
  await tgCall(env, "setMyCommands", {
    scope: { type: "all_private_chats" },
    commands: [{ command: "start", description: "开始咨询 / 激活机器人" }]
  });

  // 群组管理命令
  if (env.SUPERGROUP_ID) {
    await tgCall(env, "setMyCommands", {
      scope: { type: "chat", chat_id: env.SUPERGROUP_ID },
      commands: [
        { command: "ban", description: "封禁当前话题用户" },
        { command: "unban", description: "解封当前话题用户" },
        { command: "close", description: "关闭当前话题" },
        { command: "delete", description: "彻底删除当前话题" }
      ]
    });
  }

  return new Response(
    webhook.ok
      ? "Webhook & Commands Updated - Bot is Active"
      : "Webhook update failed"
  );
}

// ============================================================
// 20. 清理旧版 KV 数据
//   - 删除旧前缀独立 key
//   - 清理 us: 用户状态中的旧验证题字段
// ============================================================
async function handleCleanup(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!env.CLEANUP_SECRET || key !== env.CLEANUP_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let deletedKeys = 0;
  let cleanedUsers = 0;
  let cursor = undefined;

  const oldPrefixes = [
    "ban:",
    "v:",
    "u:",
    "c:",
    "chal:",
    "user_chal:",
    "wrong_count:",
    "tempban:",
    "tip_lock:"
  ];

  const oldFields = [
    "chalId",
    "chalAnswer",
    "chalUntil",
    "wrong",
    "tempbanUntil",
    "tipUntil"
  ];

  do {
    const list = await env.TOPIC_MAP.list({ limit: 1000, cursor });

    for (const k of list.keys) {
      const name = k.name;

      // 删除旧版独立 key
      if (oldPrefixes.some(p => name.startsWith(p))) {
        await env.TOPIC_MAP.delete(name);
        deletedKeys++;
        continue;
      }

      // 清理用户状态中的旧字段
      if (name.startsWith("us:")) {
        try {
          const state = await env.TOPIC_MAP.get(name, { type: "json" });
          if (!state || typeof state !== "object") continue;

          let changed = false;
          for (const field of oldFields) {
            if (field in state) {
              delete state[field];
              changed = true;
            }
          }

          if (changed) {
            if (Object.keys(state).length === 0) {
              await env.TOPIC_MAP.delete(name);
            } else {
              await env.TOPIC_MAP.put(name, JSON.stringify(state));
            }
            cleanedUsers++;
          }
        } catch (e) {
          console.error("清理用户状态失败:", name, e);
        }
      }
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  return new Response(
    `Cleanup done.\n` +
      `- Deleted old keys: ${deletedKeys}\n` +
      `- Cleaned user states: ${cleanedUsers}`
  );
}

// ============================================================
// 21. Telegram Bot API 调用封装
// ============================================================
async function tgCall(env, method, body) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let r;
    try {
      r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await r.json();
    if (!data.ok) {
      console.error(`[TG Error] ${method}`, JSON.stringify(data));
    }
    return data;
  } catch (e) {
    console.error(`[Network Error] ${method}`, e);
    return { ok: false, description: String(e) };
  }
}
