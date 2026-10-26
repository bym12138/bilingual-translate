// 网页双语对照：开启后在每一段原文下面插入译文，只翻译滚动到附近的内容
(() => {
  // 不进入这些元素内部
  const SKIP = [
    'script', 'style', 'noscript', 'template', 'code', 'pre', 'kbd', 'samp', 'textarea', 'input',
    'select', 'button', 'svg', 'math', 'canvas', 'video', 'audio', 'iframe',
    'nav', '[role="navigation"]', '[role="banner"]', '[role="menu"]', '[role="menubar"]', '[role="tablist"]',
    '.bt-trans', '.html5-video-player', '.notranslate', '[translate="no"]',
    '[contenteditable=""]', '[contenteditable="true"]',
  ].join(',');
  // 这些网站只翻译正文，菜单、侧栏、按钮一概不翻
  const X_ONLY = '[data-testid="tweetText"], [data-testid="UserDescription"]';
  const SITE_ONLY = { 'x.com': X_ONLY, 'twitter.com': X_ONLY, 'mobile.twitter.com': X_ONLY }[location.hostname];
  // 这些网站只翻这些区域里的内容，但区域里照常按段落分开翻（README 有很多段，不能当成一整段）
  // GitHub：README、Issue/PR 评论、Release 说明、Wiki 都在 .markdown-body；.f4.my-3 是仓库 About 简介
  const SITE_SCOPE = { 'github.com': '.markdown-body, .BorderGrid-cell .f4.my-3' }[location.hostname];

  let active = false;
  let seen = new WeakSet();
  let pending = [];
  let changed = new Set();
  let flushTimer = 0, scanTimer = 0;
  let io, mo;

  const isInline = el => ['inline', 'contents'].includes(getComputedStyle(el).display);

  // 一处文字所属的“段落”：离它最近的非行内元素。按实际显示判断，不看标签名，
  // 这样 YouTube 这类满是自定义标签的网站也能认出来
  function blockOf(el) {
    while (el.parentElement && el !== document.body && isInline(el)) el = el.parentElement;
    return el === document.body ? null : el;
  }

  // 只取属于这一段本身的文字；里面另起一段的块级元素会单独翻译
  function textOf(block) {
    if (SITE_ONLY) return block.innerText.replace(/\s+/g, ' ').trim();
    let s = '';
    (function walk(node) {
      for (const c of node.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) s += c.data;
        else if (c.localName === 'br') s += ' ';
        else if (c.nodeType === Node.ELEMENT_NODE && !c.matches('.bt-trans,script,style,noscript,template') && isInline(c)) walk(c);
      }
    })(block);
    return s.replace(/\s+/g, ' ').trim();
  }

  // 目标语言是中文：已经是中文的段落不翻（日文含假名，照常翻）
  const isChinese = t => {
    const han = t.match(/[一-鿿]/g)?.length || 0;
    const letters = t.match(/\p{L}/gu)?.length || 1;
    return han / letters > 0.5 && !/[぀-ヿ]/.test(t);
  };
  // 去掉 @用户名、#话题、链接后还剩正经文字才翻
  const worthTranslating = t => {
    const core = t.replace(/[@#]\S+|https?:\/\/\S+/g, '');
    return t.length <= 5000 && (core.match(/\p{L}/gu)?.length || 0) >= 2 && !isChinese(core);
  };

  function scan(root) {
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n =>
        n.nodeType === Node.ELEMENT_NODE
          ? n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
          : /\p{L}/u.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
    });
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (SITE_SCOPE && !t.parentElement.closest(SITE_SCOPE)) continue;
      const block = SITE_ONLY ? t.parentElement.closest(SITE_ONLY) : blockOf(t.parentElement);
      if (!block || seen.has(block)) continue;
      seen.add(block);
      io.observe(block);
    }
  }

  function onVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      pending.push(e.target);
    }
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 100);
  }

  function flush() {
    const items = [];
    for (const el of pending.splice(0)) {
      if (!el.isConnected) continue;
      const text = textOf(el);
      if (!text) seen.delete(el); // 文字还没出来（很多网站先建空框再填字），等它变化后再来
      if (!worthTranslating(text)) continue;
      const span = document.createElement('span');
      span.className = 'bt-trans bt-loading';
      el.appendChild(span);
      items.push({ text, span });
    }
    for (let i = 0; i < items.length; i += 40) fill(items.slice(i, i + 40));
  }

  async function fill(items) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'translate', texts: items.map(i => i.text) });
    } catch (err) {
      // 扩展更新/重新加载后，旧页面里残留的这份脚本已失效，直接停掉（刷新页面即可恢复）
      if (!chrome.runtime?.id) return stop();
      res = { error: err.message };
    }
    items.forEach(({ text, span }, i) => {
      const tr = res.translations?.[i];
      span.classList.remove('bt-loading');
      if (res.error) {
        span.classList.add('bt-error');
        span.textContent = `翻译失败：${res.error}`;
      } else if (tr && tr !== text) {
        span.textContent = tr;
      } else {
        span.remove();
      }
    });
  }

  function start() {
    active = true;
    io = new IntersectionObserver(onVisible, { rootMargin: '600px 0px' });
    // 动态加载的内容（无限滚动、评论区等）也翻译：重新检查内容有变动的地方
    mo = new MutationObserver(mutations => {
      for (const m of mutations) changed.add(m.target);
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => {
        for (const n of changed) if (n.isConnected) scan(n);
        changed.clear();
      }, 300);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    scan(document.body);
  }

  function stop() {
    active = false;
    io.disconnect();
    mo.disconnect();
    clearTimeout(flushTimer);
    clearTimeout(scanTimer);
    pending = [];
    changed.clear();
    seen = new WeakSet();
    document.querySelectorAll('.bt-trans').forEach(n => n.remove());
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'toggle') return;
    active ? stop() : start();
    sendResponse({ active });
  });
})();
