// YouTube 双语字幕：把截获的字幕整理成整句、翻译，然后自己画在播放器上（替换原生字幕）
(() => {
  let cues = []; // [{ start, end, text, tr }]，按 start 排序，单位毫秒
  let trackKey = '';
  let showTranslation = true;
  let player, overlay, srcLine, dstLine, shown;

  const clean = s => s.replace(/\s+/g, ' ').trim();

  // 人工字幕：一条事件就是一条字幕
  function parseManual(events) {
    return events
      .filter(e => e.segs)
      .map(e => ({
        start: e.tStartMs,
        end: e.tStartMs + (e.dDurationMs || 0),
        text: clean(e.segs.map(s => s.utf8).join('')),
      }))
      .filter(c => c.text)
      .sort((a, b) => a.start - b.start);
  }

  // 自动生成字幕：原始数据是逐词滚动的，按停顿和句末标点重新拼成句子，翻译才通顺
  function parseAsr(events) {
    const words = [];
    for (const e of events) {
      if (!e.segs || e.aAppend) continue;
      for (const s of e.segs) {
        const w = clean(s.utf8);
        if (w) words.push({ t: e.tStartMs + (s.tOffsetMs || 0), w });
      }
    }
    words.sort((a, b) => a.t - b.t);

    const result = [];
    let cur = null;
    words.forEach(({ t, w }, i) => {
      const prev = words[i - 1];
      if (!cur || t - prev.t > 1500 || cur.n >= 20 || (cur.n >= 4 && /[.?!。？！]$/.test(prev.w))) {
        cur = { start: t, last: t, text: '', n: 0 };
        result.push(cur);
      }
      const cjk = /[　-鿿]$/.test(cur.text) && /^[　-鿿]/.test(w);
      cur.text += cur.text && !cjk ? ' ' + w : w;
      cur.last = t;
      cur.n++;
    });
    result.forEach((c, i) => {
      const next = result[i + 1];
      c.end = Math.min(next ? next.start : Infinity, c.last + 2500);
    });
    return result;
  }

  async function translateAll(list) {
    // 从当前播放位置开始翻，眼前的字幕先出结果
    const now = (player?.querySelector('video')?.currentTime || 0) * 1000;
    const from = Math.max(0, list.findIndex(c => c.end > now));
    const ordered = [...list.slice(from), ...list.slice(0, from)];
    for (let i = 0; i < ordered.length; i += 50) {
      if (list !== cues) return; // 已经换了视频或字幕轨
      const batch = ordered.slice(i, i + 50);
      let res;
      try {
        res = await chrome.runtime.sendMessage({ type: 'translate', texts: batch.map(c => c.text) });
      } catch (err) {
        res = { error: err.message }; // 扩展重新加载后旧页面会走到这里，刷新页面即可
      }
      if (res.error) return console.warn('[双语翻译] 字幕翻译失败：', res.error);
      batch.forEach((c, k) => { c.tr = res.translations[k]; });
    }
  }

  function findCue(t) {
    let lo = 0, hi = cues.length - 1, i = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    // 人工字幕偶尔会互相重叠，往前多看几条
    for (let j = i; j >= 0 && j > i - 3; j--) if (cues[j].end > t) return cues[j];
    return null;
  }

  function render() {
    requestAnimationFrame(render);
    if (!player?.isConnected) player = document.querySelector('#movie_player');
    if (!player) return;
    if (overlay.parentElement !== player) player.appendChild(overlay);

    const video = player.querySelector('video');
    const ccButton = player.querySelector('.ytp-subtitles-button');
    const ccOn = ccButton ? ccButton.getAttribute('aria-pressed') === 'true' : true;
    player.classList.toggle('bt-hide-native', ccOn && cues.length > 0);

    const cue = video && ccOn ? findCue(video.currentTime * 1000) : null;
    const tr = showTranslation && cue?.tr && cue.tr !== cue.text ? cue.tr : '';
    if (cue === shown && dstLine.textContent === tr) return;
    shown = cue;
    overlay.hidden = !cue;
    srcLine.textContent = cue?.text || '';
    dstLine.textContent = tr;
    dstLine.parentElement.hidden = !tr;
    overlay.style.fontSize = Math.max(14, player.clientHeight * 0.04) + 'px';
  }

  function startRendering() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.className = 'bt-yt-sub';
    overlay.innerHTML = '<div><span></span></div><div><span class="bt-yt-dst"></span></div>';
    [srcLine, dstLine] = overlay.querySelectorAll('span');
    requestAnimationFrame(render);
  }

  window.addEventListener('message', e => {
    if (e.source !== window || e.data?.source !== 'bt-yt-hook') return;
    let data;
    try { data = JSON.parse(e.data.body); } catch { return; }
    if (!Array.isArray(data?.events)) return;

    const params = new URL(e.data.url, location.href).searchParams;
    const key = ['v', 'lang', 'tlang', 'kind', 'name'].map(k => params.get(k)).join('|');
    if (key === trackKey) return;
    trackKey = key;

    cues = params.get('kind') === 'asr' ? parseAsr(data.events) : parseManual(data.events);
    // 字幕本身就是中文（或用了 YouTube 自带的自动翻译成中文）时只显示原文
    showTranslation = !/^zh/i.test(params.get('tlang') || params.get('lang') || '');
    if (showTranslation) translateAll(cues);
    startRendering();
  });

  document.addEventListener('yt-navigate-start', () => {
    cues = [];
    trackKey = '';
  });
})();
