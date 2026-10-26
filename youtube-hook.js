// 运行在 YouTube 页面自身的环境里：截获播放器请求到的字幕数据，转交给 youtube.js
(() => {
  const isCaption = url => String(url).includes('/api/timedtext');
  const emit = (url, body) =>
    window.postMessage({ source: 'bt-yt-hook', url: String(url), body }, location.origin);

  const urls = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    urls.set(this, url);
    return open.apply(this, arguments);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    const url = urls.get(this);
    if (isCaption(url)) {
      this.addEventListener('load', () => {
        const r = this.response;
        emit(url, typeof r === 'string' ? r : r instanceof ArrayBuffer ? new TextDecoder().decode(r) : JSON.stringify(r));
      });
    }
    return send.apply(this, arguments);
  };

  const nativeFetch = window.fetch;
  window.fetch = async function (input) {
    const res = await nativeFetch.apply(this, arguments);
    const url = input instanceof Request ? input.url : input;
    if (isCaption(url)) res.clone().text().then(body => emit(url, body), () => {});
    return res;
  };
})();
