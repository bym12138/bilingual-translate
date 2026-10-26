// 目标语言：想翻成别的语言改这里（如 'en'、'ja'、'zh-TW'）
const TARGET_LANG = 'zh-CN';

// Chrome 自带网页翻译用的谷歌接口，免费、无需自己申请 Key，支持一次翻译多段
const API = 'https://translate-pa.googleapis.com/v1/translateHtml';
const API_KEY = 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520';

const cache = new Map();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const escapeHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unescapeHtml = s => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1))
    : ENTITIES[e.toLowerCase()] ?? m);

async function requestBatch(texts, retries = 1) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json+protobuf', 'X-Goog-API-Key': API_KEY },
      // 接口按 HTML 处理，普通换行会被吞掉，换成 <br> 才能保留
      body: JSON.stringify([[texts.map(t => escapeHtml(t).replace(/\n/g, '<br>')), 'auto', TARGET_LANG], 'te']),
    });
    if (!res.ok) throw new Error(`翻译接口返回 ${res.status}`);
    const [translations] = await res.json();
    return translations.map(t => unescapeHtml(t.replace(/\s*<br\s*\/?>\s*/gi, '\n')));
  } catch (err) {
    if (!retries) throw err;
    await new Promise(r => setTimeout(r, 1000));
    return requestBatch(texts, retries - 1);
  }
}

// 按条数和总字数切成多个请求
function chunk(texts, maxItems = 50, maxChars = 5000) {
  const batches = [];
  let cur = [], len = 0;
  for (const t of texts) {
    if (cur.length && (cur.length >= maxItems || len + t.length > maxChars)) {
      batches.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function translate(texts) {
  if (cache.size > 20000) cache.clear();
  const batches = chunk([...new Set(texts.filter(t => !cache.has(t)))]);
  // 最多 3 个请求同时进行
  for (let i = 0; i < batches.length; i += 3) {
    await Promise.all(batches.slice(i, i + 3).map(async batch => {
      const out = await requestBatch(batch);
      batch.forEach((t, k) => cache.set(t, out[k]));
    }));
  }
  return texts.map(t => cache.get(t));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'translate') return;
  translate(msg.texts).then(
    translations => sendResponse({ translations }),
    err => sendResponse({ error: err.message }),
  );
  return true;
});

// 点击扩展图标或按 ⌥A：翻译 / 还原当前网页；翻译中的标签页图标变成粉色
async function toggle(tab) {
  if (!tab?.id) return;
  const res = await chrome.tabs.sendMessage(tab.id, { type: 'toggle' }).catch(() => null);
  if (!res) return;
  const state = res.active ? 'on' : 'off';
  chrome.action.setIcon({ tabId: tab.id, path: { 16: `icons/${state}-16.png`, 32: `icons/${state}-32.png` } });
}

chrome.action.onClicked.addListener(toggle);
chrome.commands.onCommand.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggle(tab);
});
