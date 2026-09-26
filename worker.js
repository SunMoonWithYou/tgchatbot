// ============================================================
// Telegram 双向私聊机器人（Cloudflare Worker，无 Durable Object）
// ============================================================
//
// 【整体架构】
//
//   用户私聊  ⇄  Worker  ⇄  超级群组（每个用户一个话题）
//                  ⇅
//              KV 存储
//                  ⇅
//          Cloudflare Turnstile（人机验证）
//
// 【业务流程】
//
//   1. 用户首次私聊 → 弹出 Mini App 人机验证按钮
//   2. 验证通过 → 写入 verifiedUntil 状态（30 天有效）
//   3. 用户发消息 → Worker 转发到超级群组的对应用户话题
//   4. 管理员在话题里回复 → Worker 转回用户私聊
//   5. 每次用户消息 → 汇总话题里更新一张通知卡片（8 秒节流）
//
// 【管理员指令】（在话题中发送）
//   /ban    封禁当前话题对应的用户
//   /unban  解除封禁
//   /close  关闭话题（保留话题、清理 KV）
//   /delete 彻底删除话题 + KV
//
// 【并发处理策略】
//   - 同一 isolate 内：withLocalLock 内存锁串行
//   - 跨 isolate：KV 二次确认 + 双读对账兜底
//   - 不用 Durable Object（成本考虑）
//
// 【环境变量】
//   必填：
//     BOT_TOKEN              Telegram Bot Token
//     SUPERGROUP_ID          超级群组 ID（-100 开头，需开启话题）
//     TOPIC_MAP              KV 命名空间绑定
//     TURNSTILE_SITE_KEY     Turnstile 公开 Site Key
//     TURNSTILE_SECRET_KEY   Turnstile 私密 Secret Key
//     VERIFY_SECRET          验证链接 HMAC 签名密钥（自拟长随机串）
//   可选：
//     ADMIN_ID               管理员 Telegram 用户 ID（不设则所有人可管理）
//     REGISTER_SECRET        /registerWebhook 接口密钥
// ============================================================

// ============================================================
// 1. 用户可见的提示文案
//    集中管理，方便统一修改措辞
// ============================================================
const MSG = {
  ban: "🚫 <b>您已被管理员禁止咨询。</b>",
  verified: "✅ <b>您已经验证过了。</b>\n\n验证有效期内可以直接发送消息。",
  noCmd: "ℹ️ 暂不支持该指令。",
  closed: "✅ <b>本次咨询已结束。</b>\n\n如需再次咨询，请发送 /start。",
  banned: "🚫 <b>已封禁该用户。</b>",
  unbanned: "✅ <b>已解除该用户封禁。</b>",
  closedAdmin: "✅ <b>该咨询已结案。</b>",
  deleted: "🗑️ <b>正在彻底删除该咨询话题及相关记录。</b>",
  deletedUser: "🗑️ <b>本次咨询记录正在删除。</b>",
  adminStart: "🤖 <b>客服机器人运行正常。</b>",
  cfNeed:
    "🛡 <b>人机验证</b>\n\n" +
    "为了防止机器人滥用，请先完成 Cloudflare 人机验证。\n\n" +
    "点击下方按钮，在弹窗中完成验证即可。",
  cfSuccessBot: "✅ <b>人机验证通过！</b>\n\n您现在可以开始发送消息了。",
  sendFailed: "⚠️ <b>消息发送失败</b>，请稍后重试。"
};

// ============================================================
// 2. KV 键名生成
//    统一封装，避免散落的字符串拼接出错
// ============================================================
const KEY = {
  /** 用户状态：us:{userId}，JSON，存 thread_id、sessionId、ban 等 */
  user: id => `us:${id}`,
  /** 话题 → 用户的反向映射：t:{threadId}，纯字符串 userId */
  thread: id => `t:${id}`,
  /** 📬 新消息汇总话题的 thread_id（全局唯一一份） */
  todoId: "sys:todo_id",
  /** 汇总话题创建中的占位标记，防并发重复创建 */
  todoCreating: "sys:todo_creating"
};

// ============================================================
// 3. 时间与阈值常量（单位：秒，除非注明 ms）
// ============================================================

/** 人机验证有效期：30 天 */
const VERIFIED_TTL = 30 * 24 * 3600;

/** 通知卡片节流：同一用户 8 秒内只更新一次卡片，防刷屏 */
const NOTIFY_THROTTLE = 8;

/** 话题创建占位有效期：防止创建失败后永久卡死 */
const TOPIC_CREATING_TTL = 15;

/** 验证链接有效期：10 分钟，防止链接被转发后长期可用 */
const VERIFY_LINK_TTL = 600;

/** 「已发送」提示合并窗口：5 秒内的多条消息合并为一条提示 */
const TIP_MERGE_WINDOW = 5;

/** 「已发送」提示延迟删除：最后一条后 3 秒自动消失 */
const TIP_DELETE_DELAY = 3;

// ============================================================
// 4. 通用工具函数
// ============================================================

/**
 * 同一 isolate 内的 Promise 内存锁
 * 注意：不同 isolate（边缘节点）之间无法共享，跨节点并发需靠 KV 二次确认
 */
const LOCAL_LOCKS = new Map();

/**
 * 「已发送」提示的内存缓存
 * - 结构：userId → { id, count, at, token }
 * - 用内存而非 KV：避免每条消息一次 KV 写（KV 免费额度 1000 写/天）
 * - 代价：isolate 重启后缓存丢失，用户可能多看到一条提示（可接受）
 */
const TIP_CACHE = new Map();

/** 提示缓存条目的存活时间：超过则清理（防内存泄漏） */
const TIP_CACHE_TTL_MS = 60 * 1000;

/** 睡眠指定毫秒（用于重试、节流等待） */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 当前 Unix 时间戳（秒） */
function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * HTML 转义，防止用户输入中的 < > & " 破坏 Telegram HTML 解析
 * 用于所有拼接进 text/caption 的用户数据
 */
function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"]/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

/** ArrayBuffer → base64url（用于 HMAC 签名，URL 安全） */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * HMAC-SHA256 签名
 * 用于验证链接的防伪造：token = userId.exp.signature
 */
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
 * 恒定时间字符串比较
 * 防止签名比较被短路（虽然 JS 侧信道攻击难，但按规范写）
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 安全地把字符串嵌入 <script> 里
 * 将 < 替换为 \u003c，防止 </script> 提前闭合标签
 */
function jsStringLiteral(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** 统一的用户级锁键：所有以用户为单位的状态读写都用它 */
function userLockKey(userId) {
  return `user:${userId}`;
}

/**
 * 生成带过期时间的验证 token
 * 格式：{userId}.{过期时间戳}.{HMAC 签名}
 */
async function createVerifyToken(userId, env) {
  const exp = nowSec() + VERIFY_LINK_TTL;
  const payload = `${userId}.${exp}`;
  const sig = await hmacSign(env.VERIFY_SECRET, payload);
  return `${payload}.${sig}`;
}

/**
 * 解析并校验验证 token
 * 校验：格式、未过期、签名匹配
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
    if (!timingSafeEqual(sig, expected)) return null;
    return userId;
  } catch {
    return null;
  }
}

/**
 * 本地锁：同 isolate 内让 fn 串行执行
 * 原理：以 key 为链，后一个 Promise 挂在前一个后面
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

/** 返回 JSON 响应 */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * 在超级群组指定话题里发文本消息
 * 统一关闭链接预览、parse_mode=HTML
 */
function sendTopicText(env, tid, text, extra = {}) {
  return tgCall(env, "sendMessage", {
    chat_id: env.SUPERGROUP_ID,
    message_thread_id: Number(tid),
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra
  });
}

/**
 * 清理过期的提示缓存
 * 只在缓存条目较多时才遍历（避免每次调用都 O(n) 扫描）
 */
function cleanupTipCache() {
  if (TIP_CACHE.size < 200) return;
  const nowMs = Date.now();
  for (const [k, v] of TIP_CACHE) {
    if (nowMs - v.at > TIP_CACHE_TTL_MS) TIP_CACHE.delete(k);
  }
}

// ============================================================
// 5. 用户状态读写（KV）
// ============================================================

/** 读取用户状态（us:{uid}），不存在返回 {} */
async function getState(env, uid) {
  return (await env.TOPIC_MAP.get(KEY.user(uid), { type: "json" })) || {};
}

/**
 * 保存用户状态
 * - 自动清理已过期的 verifiedUntil（避免脏数据）
 * - KV put 失败时自动重试一次（应对网络抖动）
 */
async function saveState(env, uid, state) {
  const copy = { ...state };
  const now = nowSec();
  if (copy.verifiedUntil && copy.verifiedUntil <= now) {
    delete copy.verifiedUntil;
  }
  const payload = JSON.stringify(copy);
  for (let i = 0; i < 2; i++) {
    try {
      await env.TOPIC_MAP.put(KEY.user(uid), payload);
      return copy;
    } catch (e) {
      if (i === 1) {
        console.error(`[KV put failed] ${KEY.user(uid)}`, e);
        throw e;
      }
      await sleep(100);
    }
  }
}

/**
 * 在用户级锁内对 state 做「读 → 改 → 写」
 * 用法：await mutateUser(env, uid, s => { s.ban = true; });
 *
 * 注意：mutator 内只做状态读写，不要发起 Telegram API 调用
 *       （那会拉长锁持有时间，并可能引发嵌套锁死锁）
 */
async function mutateUser(env, uid, mutator) {
  return withLocalLock(userLockKey(uid), async () => {
    const state = await getState(env, uid);
    await mutator(state);
    await saveState(env, uid, state);
    return state;
  });
}

// ============================================================
// 6. Worker 主入口
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin; // 用于生成验证链接

    // ---------- 人机验证页面 ----------
    // GET：展示 Turnstile 组件
    // POST：提交验证结果，服务端校验并写入用户状态
    if (url.pathname === "/cf-verify") {
      if (request.method === "GET") return handleCfVerifyPage(request, env);
      if (request.method === "POST") return handleCfVerifySubmit(request, env, ctx);
    }

    // ---------- 注册 Webhook 与命令菜单 ----------
    // 首次部署 / 更换域名后访问一次即可，带密钥防未授权调用
    if (url.pathname === "/registerWebhook") {
      const key = url.searchParams.get("key");
      if (!env.REGISTER_SECRET || key !== env.REGISTER_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return handleRegisterWebhook(request, env);
    }

    // 其余请求只处理 Telegram Webhook 的 POST
    if (request.method !== "POST") {
      return new Response("OK");
    }

    // 解析 Telegram update
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // 回调查询（按钮点击）→ 异步处理
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
  // 先读一次状态（后面多数分支都要用它）
  let state = await getState(env, userId);
  const now = nowSec();

  // ---------- 管理员私聊：只回 /start ----------
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

  // ---------- 永久封禁：直接拒绝 ----------
  if (state.ban) {
    return tgCall(env, "sendMessage", {
      chat_id: userId,
      text: MSG.ban,
      parse_mode: "HTML"
    });
  }

  // ---------- 未验证 或 /start：走验证流程 ----------
  if (msg.text === "/start" || !state.verifiedUntil || state.verifiedUntil <= now) {
    // 已在有效期内（只是发了 /start）→ 提示已通过
    if (state.verifiedUntil && state.verifiedUntil > now) {
      return tgCall(env, "sendMessage", {
        chat_id: userId,
        text: MSG.verified,
        parse_mode: "HTML"
      });
    }
    // 未验证 → 发送 Mini App 验证按钮
    return sendCfChallenge(userId, env, origin);
  }

  // ---------- 已验证：确保话题存在 ----------
  // 传入已读到的 state，命中「已有 thread_id」时省一次 KV 读
  const topic = await ensureUserTopic(msg, env, state);
  if (!topic) return;

  state = topic.state;
  const threadId = topic.threadId;
  const sessionId = state.sessionId;

  // ---------- 同一用户消息串行化 ----------
  // 用 user-send 锁保证多条消息按顺序处理，避免媒体组顺序错乱
  await withLocalLock(`user-send:${userId}`, async () => {
    // 再次读最新状态：防止 /close /delete 期间状态已变
    const latest = await getState(env, userId);
    if (!latest.thread_id || String(latest.thread_id) !== String(threadId)) return;
    if (sessionId && latest.sessionId && sessionId !== latest.sessionId) return;
    if (latest.ban) return;

    // 转发消息到超级群组对应话题
    const sent = await sendBot(msg, env.SUPERGROUP_ID, threadId, env);
    if (!sent?.ok) {
      // 转发失败：告知用户，避免"以为发出去了"
      await tgCall(env, "sendMessage", {
        chat_id: userId,
        text: MSG.sendFailed,
        parse_mode: "HTML"
      });
      return;
    }

    // 异步触发通知卡片（不阻塞用户提示）
    ctx.waitUntil(
      triggerNotification(user, threadId, env, getPreview(msg), sent.result?.message_id)
    );

    // 更新「已发送」提示（内存缓存，5 秒内多条合并）
    await updateSendTip(env, ctx, userId);
  });
}

// ============================================================
// 7.1 「已发送」提示更新
//     设计目标：
//       - 用户快速发多条消息时，只显示一条「已发送 N 条」
//       - 避免每条消息都发一次提示导致闪烁
//       - 用内存缓存而非 KV，把 KV 写降为 0
// ============================================================
async function updateSendTip(env, ctx, userId) {
  cleanupTipCache();

  const tipToken = crypto.randomUUID();
  const nowMs = Date.now();

  let tip = TIP_CACHE.get(userId) || null;

  // 5 秒内已有提示 → 编辑它，计数 +1
  if (tip && tip.id && nowMs - tip.at < TIP_MERGE_WINDOW * 1000) {
    tip.count = (tip.count || 1) + 1;
    tip.at = nowMs;
    tip.token = tipToken;
    const edit = await tgCall(env, "editMessageText", {
      chat_id: userId,
      message_id: Number(tip.id),
      text: `✅ <b>已发送 ${tip.count} 条</b>`,
      parse_mode: "HTML"
    });
    if (!edit.ok) {
      // 提示可能已被用户删除或不可编辑 → 清缓存，走新建
      TIP_CACHE.delete(userId);
      tip = null;
    }
  }

  // 没有可用旧提示 → 新建
  if (!tip) {
    const tipRes = await tgCall(env, "sendMessage", {
      chat_id: userId,
      text: "✅ <b>已发送</b>",
      parse_mode: "HTML"
    });
    if (tipRes.ok) {
      tip = {
        id: tipRes.result.message_id,
        count: 1,
        at: nowMs,
        token: tipToken
      };
      TIP_CACHE.set(userId, tip);
    }
  }

  if (!tip) return;

  // 延迟删除：只有 token 仍匹配（期间未再合并）才删
  // 若期间有新消息更新了 token，则本次 waitUntil 静默退出
  const myToken = tip.token;
  const myId = tip.id;
  ctx.waitUntil(
    (async () => {
      await sleep(TIP_DELETE_DELAY * 1000);
      const cur = TIP_CACHE.get(userId);
      if (cur && cur.token === myToken && String(cur.id) === String(myId)) {
        await tgCall(env, "deleteMessage", {
          chat_id: userId,
          message_id: Number(myId)
        });
        TIP_CACHE.delete(userId);
      }
    })()
  );
}

// ============================================================
// 8. 发送人机验证按钮（Telegram Mini App 形式）
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
        // web_app：在 Telegram 内以弹窗打开，无需跳外部浏览器
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
    // token 无效或已过期 → 提示用户重新获取链接
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

  // 正常页面：渲染 Turnstile 组件，验证成功后自动 POST 回服务端
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
    // 服务端下发的签名 token，原样回传
    const token = ${jsStringLiteral(token)};

    // 初始化 Telegram Mini App（跟随主题、自动展开）
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
          // 短暂展示成功提示后自动关闭 Mini App
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

    // Turnstile 组件加载失败
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

    // ---------- 一次性消费：防重放 ----------
    // 同 token 提交时串行检查 + 占位，避免并发重复消费
    const usedKey = `vt:${token}`;
    let replayed = false;
    await withLocalLock(`vt:${token}`, async () => {
      const already = await env.TOPIC_MAP.get(usedKey);
      if (already) {
        replayed = true;
        return;
      }
      await env.TOPIC_MAP.put(usedKey, "1", { expirationTtl: VERIFY_LINK_TTL });
    });
    if (replayed) {
      return json({ ok: false, error: "链接已被使用" });
    }

    // ---------- 向 Cloudflare 校验 Turnstile ----------
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
      // Turnstile 拒绝 → 撤销一次性占位，允许用户重试
      await env.TOPIC_MAP.delete(usedKey);
      console.error("Turnstile failed", outcome);
      return json({ ok: false, error: "人机验证未通过" });
    }

    // ---------- 写入验证通过状态 ----------
    await mutateUser(env, userId, s => {
      s.verifiedUntil = nowSec() + VERIFIED_TTL;
    });

    // 通知用户验证通过（异步，不阻塞响应）
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

// ============================================================
// 11. 确保用户话题存在
//     流程：快速路径 → 锁内重读 → 占位 → 创建 → 二次确认
//
//     优化：调用方若已读到 thread_id（initial 参数），直接复用，
//          省掉锁内的一次 KV 读
// ============================================================
async function ensureUserTopic(msg, env, initial) {
  const user = msg.from;
  const userId = user.id;

  // 快速路径：外层已确认有 thread_id，直接返回
  if (initial && initial.thread_id) {
    return { threadId: String(initial.thread_id), state: initial };
  }

  return withLocalLock(userLockKey(userId), async () => {
    let state = await getState(env, userId);

    // 锁内重读：可能刚才在等锁期间其他请求已创建
    if (state.thread_id) {
      return { threadId: String(state.thread_id), state };
    }

    // 其他请求正在创建：短暂等待，最多 8 秒
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

    // 再次确认（等锁期间状态可能变化）
    state = await getState(env, userId);
    if (state.thread_id) {
      return { threadId: String(state.thread_id), state };
    }

    // ---------- 写入创建占位 ----------
    // 用创建 token 区分"本次创建"，便于后续清理
    const creatingToken = crypto.randomUUID();
    state.topicCreatingUntil = nowSec() + TOPIC_CREATING_TTL;
    state.topicCreatingToken = creatingToken;
    await saveState(env, userId, state);

    const displayName =
      [user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "用户";
    const topicName = displayName.substring(0, 120);

    // ---------- 调用 Telegram 创建 Forum Topic ----------
    const res = await tgCall(env, "createForumTopic", {
      chat_id: env.SUPERGROUP_ID,
      name: topicName
    });

    // 创建失败：清理自己的占位（防止卡死）
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

    // 并发下已有其他话题（其他请求抢先创建成功）
    // → 删除本次创建的，让位于已有话题
    if (state.thread_id && String(state.thread_id) !== newThreadId) {
      await tgCall(env, "deleteForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(newThreadId)
      });
      return { threadId: String(state.thread_id), state };
    }

    // ---------- 建立新会话 ----------
    // sessionId 用于在管理员 /close 后作废旧会话，拒绝迟到消息
    const sessionId = crypto.randomUUID();
    state.thread_id = newThreadId;
    state.sessionId = sessionId;
    state.original_name = topicName;
    delete state.topicCreatingUntil;
    delete state.topicCreatingToken;
    await saveState(env, userId, state);

    // 反向映射：话题 → 用户（管理员回复时用）
    await env.TOPIC_MAP.put(KEY.thread(newThreadId), String(userId));

    // 发送用户资料卡片到话题
    await sendUserProfileCard(user, newThreadId, env, topicName);

    return { threadId: newThreadId, state };
  });
}

// ============================================================
// 12. 发送用户资料卡片到话题（话题的首条消息）
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

  // 尝试获取头像（失败不影响主流程）
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
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    });
  } else {
    await sendTopicText(env, threadId, text);
  }
}

// ============================================================
// 13. 确保「📬 新消息」汇总话题存在
//     逻辑与 ensureUserTopic 类似：占位 + 二次确认
// ============================================================
async function ensureTodoTopic(env) {
  return withLocalLock(`todo-topic:${env.SUPERGROUP_ID}`, async () => {
    let todoId = await env.TOPIC_MAP.get(KEY.todoId);
    if (todoId) return String(todoId);

    // 其他请求正在创建：等待
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

    // 再确认一次
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

    // 并发下已有其他汇总话题：删除本次创建的
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
// 14. 触发新消息通知卡片
//     设计要点：
//       - 用户级锁：不同用户可并行，同用户串行
//       - 8 秒节流：同一用户 8 秒内只更新一次卡片
//       - 优先编辑旧卡片，编辑失败才新建（避免刷屏）
//       - 双读对账：防止产生孤儿卡片（KV 最终一致性的兜底）
// ============================================================
async function triggerNotification(from, userThreadId, env, preview, lastId) {
  const userId = from.id;

  return withLocalLock(userLockKey(userId), async () => {
    let state = await getState(env, userId);
    if (!state.thread_id || String(state.thread_id) !== String(userThreadId)) return;

    const sessionId = state.sessionId;
    const now = nowSec();

    // 节流：8 秒内不重复触发
    if (state.lastNotify && now - state.lastNotify < NOTIFY_THROTTLE) return;

    let todoId = await ensureTodoTopic(env);
    if (!todoId) return;

    // ---------- 拼装卡片内容 ----------
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
      // 首次出现的卡片：@ 一下管理员
      const adminMention = env.ADMIN_ID
        ? `<a href="tg://user?id=${env.ADMIN_ID}">@管理员</a>`
        : "<b>管理员</b>";
      text += `📢 呼叫 ${adminMention} [待处理]`;
    }

    // 跳转链接：t.me/c/{群组ID}/{消息ID}?thread={话题ID}
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

    // ---------- 优先编辑已有卡片 ----------
    if (cardId) {
      const edit = await tgCall(env, "editMessageText", {
        chat_id: env.SUPERGROUP_ID,
        message_id: Number(cardId),
        text,
        parse_mode: "HTML",
        reply_markup: kb
      });
      if (edit.ok) {
        // 编辑成功：更新 lastNotify 节流时间
        const latest = await getState(env, userId);
        if (!latest.thread_id || String(latest.thread_id) !== String(userThreadId)) return;
        if (sessionId && latest.sessionId && sessionId !== latest.sessionId) return;
        latest.lastNotify = now;
        await saveState(env, userId, latest);
        return;
      }
      // 编辑失败（卡片可能已被删/手动清）：清理 card_id
      const latest = await getState(env, userId);
      if (String(latest.thread_id) === String(userThreadId)) {
        delete latest.card_id;
        delete latest.lastNotify;
        await saveState(env, userId, latest);
      }
    }

    // ---------- 双读对账 ----------
    // 场景：内存里 state.card_id 为空，但 KV 里其实有值（最终一致性窗口）
    // 若直接新建会多出一张孤儿卡片 → 先把 KV 里的旧卡片删掉
    const doubleCheck = await getState(env, userId);
    if (
      doubleCheck.card_id &&
      String(doubleCheck.card_id) !== String(cardId)
    ) {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: Number(doubleCheck.card_id)
      });
      if (doubleCheck.card_id) {
        delete doubleCheck.card_id;
        delete doubleCheck.lastNotify;
        await saveState(env, userId, doubleCheck);
      }
    }

    // ---------- 创建新卡片 ----------
    let res = await tgCall(env, "sendMessage", {
      chat_id: env.SUPERGROUP_ID,
      message_thread_id: Number(todoId),
      text,
      parse_mode: "HTML",
      reply_markup: kb,
      link_preview_options: { is_disabled: true }
    });

    // 汇总话题可能被删除 → 重建后再发一次
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
        reply_markup: kb,
        link_preview_options: { is_disabled: true }
      });
    }

    if (!res.ok) return;

    // ---------- 保存新卡片 ID ----------
    const latest = await getState(env, userId);
    if (!latest.thread_id || String(latest.thread_id) !== String(userThreadId)) return;
    if (sessionId && latest.sessionId && sessionId !== latest.sessionId) return;
    latest.card_id = String(res.result.message_id);
    latest.lastNotify = now;
    await saveState(env, userId, latest);
  });
}

// ============================================================
// 15. 处理管理员在话题中的回复
//     职责：
//       - 解析管理员指令（/ban 等）
//       - 普通回复转发给用户
// ============================================================
async function handleAdminReply(msg, env, ctx) {
  const tid = String(msg.message_thread_id);

  // 忽略汇总话题（📬 新消息）里的消息
  const todoId = await env.TOPIC_MAP.get(KEY.todoId);
  if (todoId && String(tid) === String(todoId)) return;

  // 查话题绑定的用户 ID
  const uid = await env.TOPIC_MAP.get(KEY.thread(tid));
  if (!uid) return;

  // 权限校验：未配置 ADMIN_ID 时所有人可管理；配置了则仅管理员
  const isAdmin = !env.ADMIN_ID || String(msg.from?.id) === String(env.ADMIN_ID);
  if (!isAdmin) return;

  const cmd = msg.text?.trim() || "";

  // ---------- /ban：封禁用户 ----------
  if (/^\/ban\b/.test(cmd)) {
    await mutateUser(env, uid, s => { s.ban = true; });
    return sendTopicText(env, tid, MSG.banned);
  }

  // ---------- /unban：解封 ----------
  if (/^\/unban\b/.test(cmd)) {
    await mutateUser(env, uid, s => { delete s.ban; });
    return sendTopicText(env, tid, MSG.unbanned);
  }

  // ---------- /close：关闭话题（保留话题、清理 KV） ----------
  if (/^\/close\b/.test(cmd)) {
    await withLocalLock(userLockKey(uid), async () => {
      const state = await getState(env, uid);
      const name = state.original_name || uid;

      // 删除通知卡片
      if (state.card_id) {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: Number(state.card_id)
        });
      }

      // 话题标题加「[已结案]」前缀
      await tgCall(env, "editForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid),
        name: `[已结案] ${name}`.substring(0, 60)
      });

      await sendTopicText(env, tid, MSG.closedAdmin);

      // 关闭话题（Telegram API）
      const closeRes = await tgCall(env, "closeForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid)
      });

      if (!closeRes.ok) {
        await sendTopicText(
          env,
          tid,
          `⚠️ <b>关闭话题失败</b>\n\n${escapeHtml(closeRes.description || "未知错误")}`
        );
        return;
      }

      // 清理 KV：用户状态 + 话题映射
      await Promise.all([
        env.TOPIC_MAP.delete(KEY.user(uid)),
        env.TOPIC_MAP.delete(KEY.thread(tid))
      ]);

      // 通知用户本次咨询已结束
      await tgCall(env, "sendMessage", {
        chat_id: uid,
        text: MSG.closed,
        parse_mode: "HTML"
      });
    });
    return;
  }

  // ---------- /delete：彻底删除话题 + KV ----------
  if (/^\/delete\b/.test(cmd)) {
    await withLocalLock(userLockKey(uid), async () => {
      const state = await getState(env, uid);

      if (state.card_id) {
        await tgCall(env, "deleteMessage", {
          chat_id: env.SUPERGROUP_ID,
          message_id: Number(state.card_id)
        });
      }

      await sendTopicText(env, tid, MSG.deleted);

      const delRes = await tgCall(env, "deleteForumTopic", {
        chat_id: env.SUPERGROUP_ID,
        message_thread_id: Number(tid)
      });

      // 删除失败：保留 KV，避免状态与话题不一致
      if (!delRes.ok) {
        await sendTopicText(
          env,
          tid,
          `⚠️ <b>删除话题失败</b>\n` +
            `原因：${escapeHtml(delRes.description || "未知错误")}\n\n` +
            `请检查机器人是否拥有「删除消息」权限。`
        );
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
    return;
  }

  // ---------- 其他 / 指令：提示不支持（回执到话题，不是用户） ----------
  if (/^\//.test(cmd)) {
    return sendTopicText(env, tid, MSG.noCmd);
  }

  // ---------- 普通管理员回复 ----------
  // 需要在锁内调 API（删卡片），不用 mutateUser，显式写锁
  await withLocalLock(userLockKey(uid), async () => {
    const state = await getState(env, uid);

    // 有通知卡片就删掉（已被回复，无需提示了）
    if (state.card_id) {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: Number(state.card_id)
      });
      delete state.card_id;
      delete state.lastNotify;
    }

    // 管理员回复相当于用户活跃 → 顺带续期验证状态
    const now = nowSec();
    if (!state.verifiedUntil || state.verifiedUntil < now + 2 * 24 * 3600) {
      state.verifiedUntil = now + VERIFIED_TTL;
    }
    await saveState(env, uid, state);
  });

  // 转发管理员的回复给用户（thread 参数为 null，因为是私聊）
  await sendBot(msg, uid, null, env);
}

// ============================================================
// 16. 通用消息转发（支持多种媒体类型）
//     原则：
//       - 用 file_id 转发，不下载重传（不受 50MB/20MB 限制）
//       - 关闭链接预览（避免话题里出现一堆网页预览卡片）
// ============================================================
async function sendBot(msg, target, thread, env) {
  const base = { chat_id: target };
  if (thread) base.message_thread_id = Number(thread);

  // 统一的「关闭链接预览」片段
  const noPreview = { link_preview_options: { is_disabled: true } };

  // ---------- 纯文本 ----------
  if (msg.text) {
    const body = { ...base, text: msg.text, ...noPreview };
    if (msg.entities) body.entities = msg.entities;
    return tgCall(env, "sendMessage", body);
  }

  // ---------- 图片（取最大尺寸） ----------
  if (msg.photo) {
    const body = {
      ...base,
      photo: msg.photo[msg.photo.length - 1].file_id,
      caption: msg.caption,
      ...noPreview
    };
    if (msg.caption_entities) body.caption_entities = msg.caption_entities;
    return tgCall(env, "sendPhoto", body);
  }

  // ---------- 视频 ----------
  if (msg.video) {
    const body = {
      ...base,
      video: msg.video.file_id,
      caption: msg.caption,
      ...noPreview
    };
    if (msg.caption_entities) body.caption_entities = msg.caption_entities;
    return tgCall(env, "sendVideo", body);
  }

  // ---------- 动画 / GIF ----------
  if (msg.animation) {
    const body = {
      ...base,
      animation: msg.animation.file_id,
      caption: msg.caption,
      ...noPreview
    };
    if (msg.caption_entities) body.caption_entities = msg.caption_entities;
    return tgCall(env, "sendAnimation", body);
  }

  // ---------- 视频消息（圆形） ----------
  if (msg.video_note) {
    return tgCall(env, "sendVideoNote", {
      ...base,
      video_note: msg.video_note.file_id
    });
  }

  // ---------- 贴纸 ----------
  if (msg.sticker) {
    return tgCall(env, "sendSticker", {
      ...base,
      sticker: msg.sticker.file_id
    });
  }

  // ---------- 语音 ----------
  if (msg.voice) {
    return tgCall(env, "sendVoice", {
      ...base,
      voice: msg.voice.file_id,
      caption: msg.caption,
      ...noPreview
    });
  }

  // ---------- 音频文件 ----------
  if (msg.audio) {
    return tgCall(env, "sendAudio", {
      ...base,
      audio: msg.audio.file_id,
      caption: msg.caption,
      caption_entities: msg.caption_entities,
      ...noPreview
    });
  }

  // ---------- 文档 ----------
  if (msg.document) {
    return tgCall(env, "sendDocument", {
      ...base,
      document: msg.document.file_id,
      caption: msg.caption,
      caption_entities: msg.caption_entities,
      ...noPreview
    });
  }

  // ---------- 位置 ----------
  if (msg.location) {
    return tgCall(env, "sendLocation", {
      ...base,
      latitude: msg.location.latitude,
      longitude: msg.location.longitude
    });
  }

  // ---------- 联系人 ----------
  if (msg.contact) {
    return tgCall(env, "sendContact", {
      ...base,
      phone_number: msg.contact.phone_number,
      first_name: msg.contact.first_name,
      last_name: msg.contact.last_name
    });
  }

  // 不支持的类型
  return { ok: false };
}

// ============================================================
// 17. 处理回调查询（inline 按钮点击）
//     目前只有「🗑️ 忽略卡片」一个回调
// ============================================================
async function handleCallback(query, env) {
  const data = query.data || "";
  const userId = query.from.id;

  // 统一 ack：避免按钮一直转圈
  const ack = (text) =>
    tgCall(env, "answerCallbackQuery", {
      callback_query_id: query.id,
      ...(text ? { text } : {})
    });

  // 非已知回调：只 ack 不做别的
  if (!data.startsWith("del:")) {
    await ack();
    return;
  }

  // data 格式："del:{目标用户ID}"
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

  // 删除卡片 + 清理 KV 里的 card_id
  await withLocalLock(userLockKey(targetUid), async () => {
    if (query.message?.message_id) {
      await tgCall(env, "deleteMessage", {
        chat_id: env.SUPERGROUP_ID,
        message_id: query.message.message_id
      });
    }
    const state = await getState(env, targetUid);
    delete state.card_id;
    delete state.lastNotify;
    await saveState(env, targetUid, state);
  });

  await ack("已忽略");
}

// ============================================================
// 18. 生成消息预览（用于通知卡片的"内容"行）
//     只取前 30 字符，避免卡片过长
// ============================================================
function getPreview(msg) {
  if (!msg) return "[未知消息]";
  if (msg.text) return msg.text.substring(0, 30);
  if (msg.caption) return msg.caption.substring(0, 30);
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
//     通过 /registerWebhook?key=xxx 触发，密钥由 REGISTER_SECRET 校验
// ============================================================
async function handleRegisterWebhook(request, env) {
  const domain = `https://${new URL(request.url).hostname}`;

  // 设置 Webhook 地址，丢弃积压的旧 update
  const webhook = await tgCall(env, "setWebhook", {
    url: domain,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true
  });

  // 私聊命令菜单（用户看到的 / 菜单）
  await tgCall(env, "setMyCommands", {
    scope: { type: "all_private_chats" },
    commands: [{ command: "start", description: "开始咨询 / 激活机器人" }]
  });

  // 群组管理命令菜单（管理员在话题里能看到的 / 菜单）
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
      : `Webhook update failed: ${webhook.description || "unknown"}`
  );
}

// ============================================================
// 20. Telegram Bot API 调用封装
//     - 15 秒超时（AbortController）
//     - 非 2xx / ok=false 时打日志
//     - 网络异常返回 { ok: false, description }
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
