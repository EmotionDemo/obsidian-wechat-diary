// 引用消息与未知 item 的纯函数回归测试。
const Module = require("module");
const path = require("path");

class Plugin {}
class PluginSettingTab {}
class Setting {}
class Modal {}
class Notice {}
class AbstractInputSuggest {}
const stub = {
  Plugin, PluginSettingTab, Setting, Modal, Notice, AbstractInputSuggest,
  moment: () => ({ format: () => "2026-09-01" }),
  normalizePath: (p) => p,
  requestUrl: async () => ({}),
  Platform: { isDesktop: true },
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") return stub;
  return originalLoad.call(this, request, ...rest);
};

const PluginClass = require(path.join(__dirname, "..", "main.js"));
const I = PluginClass.__internals;
let pass = 0;
let fail = 0;
function check(name, condition, extra) {
  if (condition) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? " → " + extra : "")); }
}

console.log("\n【引用消息】");
let ref = I.extractRefMessage({ item_list: [{ type: 1, text_item: { text: "原消息第一行\n第二行" } }] });
check("提取引用文字", ref && ref.text === "原消息第一行\n第二行", JSON.stringify(ref));
let quote = I.quoteMarkdown(ref.text, "微信引用");
check("输出 Obsidian quote callout", quote === "> [!quote] 微信引用\n> 原消息第一行\n> 第二行", quote);

ref = I.extractRefMessage({
  message: { items: [
    { image_item: { media: { aes_key: "secret-must-not-leak" } } },
    { file_item: { file_name: "报告.pdf", media: { url: "https://secret.example" } } },
  ] },
});
check("引用媒体生成可读占位", ref && ref.text.includes("引用的图片、文件：报告.pdf"), JSON.stringify(ref));
check("引用媒体不泄漏协议密钥", !ref.text.includes("secret") && !ref.text.includes("https://"), ref.text);

console.log("\n【未知消息诊断】");
const summary = I.unknownMessageSummary({
  message_type: 1,
  message_state: 2,
  item_list: [{ type: 49, app_item: { title: "敏感标题" }, context_token: "secret", media_url: "https://secret.example" }],
}, [{ type: 49, app_item: { title: "敏感标题" }, context_token: "secret", media_url: "https://secret.example" }]);
check("保留类型编号", summary.itemTypes[0] === 49, JSON.stringify(summary));
check("过滤敏感顶层字段名", summary.itemKeys[0].includes("type") && summary.itemKeys[0].includes("app_item") && !summary.itemKeys[0].includes("context_token") && !summary.itemKeys[0].includes("media_url"), JSON.stringify(summary));
check("摘要不含正文、URL、token 值", !JSON.stringify(summary).includes("敏感标题") && !JSON.stringify(summary).includes("secret.example"), JSON.stringify(summary));
check("用户引导说明替代方案", I.UNSUPPORTED_FORWARD_REPLY.includes("复制文字或链接") && I.UNSUPPORTED_FORWARD_REPLY.includes("直接发送"));

async function integration() {
  check("内部 Agent 版本与增强版 manifest 一致", I.BOT_AGENT.endsWith("/" + require("../manifest.json").version), I.BOT_AGENT);

  console.log("\n【入站链路】");
  const p = Object.create(PluginClass.prototype);
  const writes = [];
  const replies = [];
  p.data = { ilink: { userId: "U1", recentSeqs: [], contextTokens: {} }, unknownMessages: [] };
  p.settings = { saveVoiceAudio: false };
  p._skipBacklog = false;
  p._client = { sendText: async (_to, text) => { replies.push(text); } };
  p._isPaused = () => false;
  p.persist = async () => {};
  p.agent = {
    onMessage: async (_from, text) => { writes.push(text); return "记下来啦"; },
    commitNudge: () => false,
  };
  await p._handleIncoming({
    from_user_id: "U1", seq: "ref-1", message_type: 1, message_state: 2,
    item_list: [{ type: 1, text_item: { text: "我的补充", ref_msg: { text: "被引用的话" } } }],
  });
  check("引用文字进入同一日记块", writes[0] === "我的补充\n\n> [!quote] 微信引用\n> 被引用的话", writes[0]);

  await p._handleIncoming({
    from_user_id: "U1", seq: "unknown-1", message_type: 1, message_state: 2,
    item_list: [{ type: 49, app_item: { title: "公众号卡片" }, context_token: "do-not-store" }],
  });
  check("未知 item 写入可见占位", writes[1] && writes[1].includes("暂不支持的微信内容"), writes[1]);
  check("未知 item 回执带替代操作", replies[1] && replies[1].includes("复制文字或链接"), replies[1]);
  check("未知 item 留一条脱敏诊断", p.data.unknownMessages.length === 1 && !JSON.stringify(p.data.unknownMessages).includes("公众号卡片"), JSON.stringify(p.data.unknownMessages));

  const before = writes.length;
  await p._handleIncoming({
    from_user_id: "U1", seq: "tool-1", message_type: 1, message_state: 2,
    item_list: [{ type: 11, tool_call_start: { name: "internal" } }],
  });
  check("协议内部工具事件不入库", writes.length === before, JSON.stringify(writes));

  const loopPlugin = Object.create(PluginClass.prototype);
  let polls = 0;
  const loopClient = {
    getUpdates: async () => {
      polls += 1;
      if (polls === 1) return { json: { ret: 0, get_updates_buf: "MUST_NOT_ADVANCE", msgs: [{ from_user_id: "U1", seq: "broken" }] } };
      loopPlugin._running = false;
      return { __timeout: true };
    },
  };
  loopPlugin._client = loopClient;
  loopPlugin._running = true;
  loopPlugin._failCount = 0;
  loopPlugin._noticedDown = false;
  loopPlugin._skipBacklog = false;
  loopPlugin._sleepCancels = new Set();
  loopPlugin.data = { ilink: { buf: "OLD_CURSOR", recentSeqs: ["sbroken"], pauseUntil: 0, lastAliveTs: 0 } };
  loopPlugin._isPaused = () => false;
  loopPlugin._setStatus = () => {};
  loopPlugin._handleIncoming = async () => { throw new Error("模拟写入失败"); };
  loopPlugin.persist = async () => {};
  await loopPlugin._loop();
  check("单条处理失败不推进批次游标", loopPlugin.data.ilink.buf === "OLD_CURSOR", loopPlugin.data.ilink.buf);
  check("失败消息去重键回滚以便重试", !loopPlugin.data.ilink.recentSeqs.includes("sbroken"), JSON.stringify(loopPlugin.data.ilink.recentSeqs));
}

integration().then(() => {
  console.log("\n────────────────────────");
  console.log(fail === 0 ? `全部通过 (${pass})` : `${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((error) => { console.error(error); process.exit(2); });
