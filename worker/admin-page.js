// 模板广场管理页（只给 Prince 用）。自包含：无外部脚本 / 样式，CSP 只放行同源请求。
// 投稿内容一律不可信：只经 textContent / value 写进页面，绝不拼 HTML。密码只存 sessionStorage（关掉标签页即忘）。
// 注意：下面整页是一个模板字符串——页内脚本里不许出现反引号和「$ + {」。
export const ADMIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>模板广场 · 管理</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #16171a; color: #e6e6e6; }
  h1 { font-size: 1.2em; margin: 0 0 12px; }
  h2 { font-size: 1.05em; margin: 20px 0 8px; }
  input, button { font: inherit; }
  input[type=password] { padding: 6px 8px; min-width: 260px; background: #23252b; color: inherit; border: 1px solid #444; border-radius: 6px; }
  button { padding: 6px 12px; border-radius: 6px; border: 1px solid #555; background: #2b2e35; color: inherit; cursor: pointer; }
  button.go { background: #2f6f4f; border-color: #2f6f4f; }
  button.bad { background: #7a2f2f; border-color: #7a2f2f; }
  button:disabled { opacity: .5; cursor: default; }
  .card { border: 1px solid #333; border-radius: 10px; padding: 10px 12px; margin: 8px 0; background: #1d1f24; }
  .meta { font-size: .9em; opacity: .8; margin: 4px 0; }
  pre { white-space: pre-wrap; word-break: break-word; background: #111215; padding: 8px; border-radius: 6px; max-height: 320px; overflow: auto; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  #msg { margin: 8px 0; min-height: 1.2em; }
  .err { color: #ff8a80; } .ok { color: #9be7a8; }
</style>
</head>
<body>
<h1>🌐 模板广场 · 管理</h1>
<div class="row" id="login">
  <input type="password" id="pw" placeholder="管理密码" autocomplete="current-password">
  <button id="pw-go">进入</button>
</div>
<div class="row" id="bar" hidden>
  <button id="refresh">刷新</button>
  <button id="logout">退出</button>
</div>
<div id="msg"></div>
<div id="main" hidden>
  <h2 id="pending-h">待审核</h2>
  <div id="pending"></div>
  <h2 id="published-h">已发布</h2>
  <div id="published"></div>
</div>
<script>
(function () {
  'use strict';
  var KEY = 'so-hub-admin-token';
  var $ = function (id) { return document.getElementById(id); };
  var token = sessionStorage.getItem(KEY) || '';
  var ERR = {
    unauthorized: '密码不对。', locked: '今天密码输错太多次，已暂时锁住（明天再试）。',
    admin_not_configured: '服务器还没设置管理密码（ADMIN_TOKEN）。', not_found: '这一条已经不在了（可能已处理过）。',
    already_done: '这一条已经处理过了。', update_target_gone: '要更新的那个模板已被删除，没法发布这次更新。',
    bad_ref: '请求有误。', bad_id: '请求有误。', upstream: '服务器出错了，稍后再试。'
  };
  function say(text, cls) { var m = $('msg'); m.textContent = text || ''; m.className = cls || ''; }
  function el(tag, text, cls) { var e = document.createElement(tag); if (text != null) e.textContent = String(text); if (cls) e.className = cls; return e; }

  function api(path, body) {
    var init = { method: body ? 'POST' : 'GET', headers: { 'Authorization': 'Bearer ' + token } };
    if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch('/admin/api/' + path, init).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'upstream' }; }).then(function (j) {
        if (!j.ok) { var e = new Error(ERR[j.error] || ('出错：' + (j.error || r.status))); e.code = j.error; throw e; }
        return j;
      });
    });
  }

  function showLoggedIn(on) {
    $('login').hidden = on; $('bar').hidden = !on; $('main').hidden = !on;
  }

  function pendingCard(s) {
    var v = s.value || {};
    var c = el('div', null, 'card');
    c.appendChild(el('div', (v.updateOf ? '【更新 ' + v.updateOf + '】 ' : '【新模板】 ') + (v.name || '')));
    c.appendChild(el('div', '作者：' + (v.author || '匿名') + ' · 标签：' + (v.tags || []).join(' / ') + ' · 测试模型：' + (v.model || '—'), 'meta'));
    if (v.description) c.appendChild(el('div', '说明：' + v.description, 'meta'));
    c.appendChild(el('div', '投稿时间：' + (s.at || '') + ' · 客户端：' + (v.client || '—'), 'meta'));
    c.appendChild(el('pre', v.prompt || ''));
    var row = el('div', null, 'row');
    var ok = el('button', '发布', 'go');
    var no = el('button', '拒绝', 'bad');
    ok.onclick = function () {
      ok.disabled = no.disabled = true;
      api('approve', { ref: s.ref }).then(function (j) { say('已发布为 ' + j.id + (j.version > 1 ? '（第 ' + j.version + ' 版）' : ''), 'ok'); load(); })
        .catch(function (e) { say(e.message, 'err'); ok.disabled = no.disabled = false; });
    };
    no.onclick = function () {
      if (!confirm('拒绝并删除这条投稿？')) return;
      ok.disabled = no.disabled = true;
      api('reject', { ref: s.ref }).then(function () { say('已拒绝。', 'ok'); load(); })
        .catch(function (e) { say(e.message, 'err'); ok.disabled = no.disabled = false; });
    };
    row.appendChild(ok); row.appendChild(no); c.appendChild(row);
    return c;
  }

  function publishedCard(t) {
    var c = el('div', null, 'card');
    c.appendChild(el('div', t.id + ' · ' + (t.name || '') + ' · 第 ' + t.version + ' 版'));
    c.appendChild(el('div', '作者：' + (t.author || '匿名') + ' · 标签：' + (t.tags || []).join(' / ') + ' · 更新于 ' + (t.updatedAt || ''), 'meta'));
    var det = document.createElement('details');
    det.appendChild(el('summary', '看正文'));
    det.appendChild(el('pre', t.prompt || ''));
    c.appendChild(det);
    var del = el('button', '删除', 'bad');
    del.onclick = function () {
      if (!confirm('从广场删除 ' + t.id + '「' + (t.name || '') + '」？已经下载的人不受影响。')) return;
      del.disabled = true;
      api('delete', { id: t.id }).then(function () { say('已删除 ' + t.id + '。', 'ok'); load(); })
        .catch(function (e) { say(e.message, 'err'); del.disabled = false; });
    };
    c.appendChild(del);
    return c;
  }

  function load() {
    return Promise.all([api('pending'), api('published')]).then(function (r) {
      showLoggedIn(true);
      var p = $('pending'), q = $('published');
      p.textContent = ''; q.textContent = '';
      $('pending-h').textContent = '待审核（' + r[0].pending.length + '）';
      $('published-h').textContent = '已发布（' + r[1].templates.length + '）';
      if (!r[0].pending.length) p.appendChild(el('div', '没有待审核的投稿。', 'meta'));
      r[0].pending.forEach(function (s) { p.appendChild(pendingCard(s)); });
      if (!r[1].templates.length) q.appendChild(el('div', '还没有已发布的模板。', 'meta'));
      r[1].templates.forEach(function (t) { q.appendChild(publishedCard(t)); });
    }).catch(function (e) {
      if (e.code === 'unauthorized' || e.code === 'locked') { token = ''; sessionStorage.removeItem(KEY); showLoggedIn(false); }
      say(e.message, 'err');
    });
  }

  $('pw-go').onclick = function () { token = $('pw').value; $('pw').value = ''; sessionStorage.setItem(KEY, token); say(''); load(); };
  $('pw').onkeydown = function (e) { if (e.key === 'Enter') $('pw-go').click(); };
  $('refresh').onclick = function () { say(''); load(); };
  $('logout').onclick = function () { token = ''; sessionStorage.removeItem(KEY); showLoggedIn(false); say('已退出。'); };
  if (token) load();
})();
</script>
</body>
</html>
`;
