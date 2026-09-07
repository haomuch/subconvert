/**
 * SubConvert Frontend
 * Handles form submission, link management, authentication, and UI interactions.
 */

const API = {
  convert: '/api/convert',
  links: '/api/links',
  auth: '/api/auth',
};

const FORMAT_LABELS = {
  clash: 'YAML',
  singbox: 'JSON',
  base64: 'Base64',
  plain: 'Plain',
};

const AUTH_KEY = 'subconvert_access_password';
let currentPassword = localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY) || '';

// ─── DOM Helpers ──────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Auth State Management ────────────────────────────────

function getAuthHeaders() {
  const headers = {};
  if (currentPassword) {
    headers['X-Access-Password'] = currentPassword;
  }
  return headers;
}

async function fetchWithAuth(url, options = {}) {
  const headers = {
    ...getAuthHeaders(),
    ...(options.headers || {}),
  };
  const resp = await fetch(url, { ...options, headers });
  if (resp.status === 401) {
    handleUnauthorized();
    throw new Error('访问密码错误或已失效');
  }
  return resp;
}

function handleUnauthorized() {
  currentPassword = '';
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
  showAuthModal();
  showAuthError('访问密码错误或已失效，请重新输入');
}

function showAuthModal() {
  $('#authModal').hidden = false;
  $('#accessPassword').focus();
}

function hideAuthModal() {
  $('#authModal').hidden = true;
  hideAuthError();
  $('#accessPassword').value = '';
}

function showAuthError(msg) {
  const errEl = $('#authError');
  errEl.textContent = msg;
  errEl.hidden = false;
}

function hideAuthError() {
  const errEl = $('#authError');
  errEl.hidden = true;
  errEl.textContent = '';
}

function setAuthLoading(loading) {
  const btn = $('#btnAuthSubmit');
  btn.disabled = loading;
  btn.querySelector('.btn-text').hidden = loading;
  btn.querySelector('.btn-loading').hidden = !loading;
}

async function checkAuthStatus() {
  try {
    const resp = await fetch(API.auth, { headers: getAuthHeaders() });
    const data = await resp.json();

    if (!data.required) {
      // Backend does not require authentication
      hideAuthModal();
      $('#btnLogout').hidden = true;
      return true;
    }

    // Backend requires authentication
    $('#btnLogout').hidden = false;

    if (data.authenticated) {
      hideAuthModal();
      return true;
    } else {
      showAuthModal();
      return false;
    }
  } catch (err) {
    console.error('Failed to check auth status:', err);
    return true;
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const pwdInput = $('#accessPassword');
  const pwd = pwdInput.value.trim();
  const remember = $('#rememberPassword').checked;

  if (!pwd) return;

  setAuthLoading(true);
  hideAuthError();

  try {
    const resp = await fetch(API.auth, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Password': pwd,
      },
      body: JSON.stringify({ password: pwd }),
    });

    const json = await resp.json();
    if (!resp.ok || !json.authenticated) {
      showAuthError(json.error || '访问密码错误');
      return;
    }

    currentPassword = pwd;
    if (remember) {
      localStorage.setItem(AUTH_KEY, pwd);
      sessionStorage.removeItem(AUTH_KEY);
    } else {
      sessionStorage.setItem(AUTH_KEY, pwd);
      localStorage.removeItem(AUTH_KEY);
    }

    hideAuthModal();
    toast('解锁成功', 'success');
    loadLinks();
  } catch (err) {
    showAuthError('网络错误或验证失败，请重试');
  } finally {
    setAuthLoading(false);
  }
}

function handleLogout() {
  currentPassword = '';
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(AUTH_KEY);
  toast('已锁定首页', 'info');
  showAuthModal();
}

// ─── Toast Notifications ──────────────────────────────────

function toast(message, type = 'info', title = '') {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;

  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const titles = { success: '成功', error: '错误', warning: '警告', info: '提示' };

  el.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <div class="toast-body">
      <strong>${title || titles[type] || titles.info}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
    <button class="toast-close">&times;</button>
  `;

  container.appendChild(el);

  const remove = () => {
    el.classList.add('toast-out');
    setTimeout(() => el.remove(), 200);
  };

  el.querySelector('.toast-close').addEventListener('click', remove);
  setTimeout(remove, 4000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── API Calls ────────────────────────────────────────────

async function apiCreateLink(data) {
  const resp = await fetchWithAuth(API.convert, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || 'Request failed');
  return json;
}

async function apiListLinks() {
  const resp = await fetchWithAuth(API.links);
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || 'Failed to load links');
  return json.links || [];
}

async function apiDeleteLink(path) {
  const resp = await fetchWithAuth(`${API.links}?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || 'Delete failed');
  return json;
}

// ─── UI Actions ───────────────────────────────────────────

function setLoading(loading) {
  const btn = $('#btnSubmit');
  btn.disabled = loading;
  btn.querySelector('.btn-text').hidden = loading;
  btn.querySelector('.btn-loading').hidden = !loading;
}

async function handleSubmit(e) {
  e.preventDefault();

  const sourceUrl = $('#sourceUrl').value.trim();
  const targetFormat = $('#targetFormat').value;
  const customPath = $('#customPath').value.trim();

  if (!sourceUrl) {
    toast('请输入源订阅 URL', 'error');
    return;
  }

  if (customPath && !/^[a-zA-Z0-9\-_ ]+$/.test(customPath)) {
    toast('自定义路径仅支持英文、数字、连字符、下划线（空格自动转连字符），不支持斜杠和点，请修改或留空', 'error');
    return;
  }

  setLoading(true);
  try {
    const result = await apiCreateLink({ sourceUrl, targetFormat, customPath });
    toast(`转换链接已创建：${result.subscriptionUrl}`, 'success');

    // Reset form
    $('#convertForm').reset();

    // Optimistic: immediately add the new link to the table
    addLinkToTable(result);
    // Remember it so the periodic sync won't wipe it during KV's
    // eventual-consistency window (the server list may lag the write).
    optimisticCreated.set(result.customPath, Date.now());

    // Then sync with server after a short delay (merge mode → keeps the
    // optimistic row even if the server list hasn't caught up yet).
    setTimeout(() => loadLinks(true), 500);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setLoading(false);
  }
}

async function loadLinks(merge = false) {
  try {
    const links = await apiListLinks();
    renderLinks(links, { merge });
  } catch (err) {
    if (err.message.includes('访问密码错误')) return;
    toast('加载链接列表失败：' + err.message, 'error');
  }
}

// ─── Optimistic-update consistency buffers ────────────────
// KV reads (especially `list`) are eventually consistent: a freshly
// created/deleted item may not appear (or may still appear) in the
// server list for a few seconds. We keep a grace window so the periodic
// merge-sync doesn't clobber rows we just created/deleted optimistically.
const GRACE_MS = 60000;
const optimisticCreated = new Map(); // path -> timestamp(ms)
const optimisticDeleted = new Map(); // path -> timestamp(ms)

function renderLinks(links, { merge = false } = {}) {
  const tbody = $('#linksBody');
  const table = $('#linksTable');
  const empty = $('#emptyState');
  const countEl = $('#linkCount');

  const updateCount = () => {
    const n = tbody.children.length;
    countEl.textContent = `共 ${n} 条链接`;
    table.hidden = n === 0;
    empty.hidden = n > 0;
  };

  // Full render (initial load): wipe and rebuild.
  if (!merge) {
    tbody.innerHTML = '';
    for (const link of links) addLinkRow(link);
    updateCount();
    return;
  }

  // Merge render: reconcile by customPath so optimistic rows survive KV lag.
  const now = Date.now();
  const serverPaths = new Set(links.map(l => l.customPath));

  // Map of existing rows keyed by path
  const existing = new Map();
  for (const tr of tbody.querySelectorAll('tr')) {
    existing.set(tr.dataset.path, tr);
  }

  // 1) Insert or update rows that exist on the server (skip just-deleted ones)
  for (const link of links) {
    if (optimisticDeleted.has(link.customPath)) continue;
    const tr = existing.get(link.customPath);
    if (tr) {
      updateLinkRow(tr, link);
    } else {
      addLinkRow(link);
    }
    existing.delete(link.customPath);
  }

  // 2) Remove DOM rows absent from server, unless we just created them
  //    (consistency lag) or just deleted them.
  for (const [path, tr] of existing) {
    if (optimisticCreated.has(path)) continue;
    if (optimisticDeleted.has(path)) { tr.remove(); continue; }
    tr.remove();
  }

  // 3) Expire stale grace entries
  for (const [p, t] of optimisticCreated) if (now - t > GRACE_MS) optimisticCreated.delete(p);
  for (const [p, t] of optimisticDeleted) if (now - t > GRACE_MS) optimisticDeleted.delete(p);

  updateCount();
}

function buildRowInner(link) {
  return `
    <td>
      <div class="cell-name"><a class="cell-path-link" href="${escapeHtml(link.subscriptionUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.subscriptionUrl)}">${escapeHtml(link.customPath)}</a></div>
    </td>
    <td class="cell-url" title="${escapeHtml(link.sourceUrl)}">${escapeHtml(link.sourceUrl)}</td>
    <td><span class="cell-format">${FORMAT_LABELS[link.targetFormat] || link.targetFormat}</span></td>
    <td>
      <div class="cell-actions">
        <button class="btn-icon" data-action="copy" data-url="${escapeHtml(link.subscriptionUrl)}" title="复制订阅链接">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        </button>
        <button class="btn-icon btn-danger" data-action="delete" data-path="${escapeHtml(link.customPath)}" title="删除">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </td>
  `;
}

function addLinkRow(link) {
  const tbody = $('#linksBody');
  const tr = document.createElement('tr');
  tr.dataset.path = link.customPath;
  tr.innerHTML = buildRowInner(link);
  tbody.appendChild(tr);

  // Bind this row's action buttons
  tr.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', handleAction);
  });

  return tr;
}

function updateLinkRow(tr, link) {
  tr.dataset.path = link.customPath;
  tr.innerHTML = buildRowInner(link);
  tr.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', handleAction);
  });
}

function addLinkToTable(link) {
  const table = $('#linksTable');
  const empty = $('#emptyState');
  const countEl = $('#linkCount');

  // Show table, hide empty state
  table.hidden = false;
  empty.hidden = true;

  // If a row with the same path already exists, remove it first
  const existing = $(`tr[data-path="${CSS.escape(link.customPath)}"]`);
  if (existing) existing.remove();

  // Insert at the top (newest first)
  const tbody = $('#linksBody');
  const tr = addLinkRow(link);
  tbody.insertBefore(tr, tbody.firstChild);

  // Update count
  const count = tbody.children.length;
  countEl.textContent = `共 ${count} 条链接`;
}

function removeLinkFromTable(path) {
  const tbody = $('#linksBody');
  const row = $(`tr[data-path="${CSS.escape(path)}"]`);
  if (row) row.remove();

  const count = tbody.children.length;
  $('#linkCount').textContent = `共 ${count} 条链接`;

  if (count === 0) {
    $('#linksTable').hidden = true;
    $('#emptyState').hidden = false;
  }
}

async function handleAction(e) {
  const btn = e.currentTarget;
  const action = btn.dataset.action;

  if (action === 'copy') {
    const url = btn.dataset.url;
    try {
      await navigator.clipboard.writeText(url);
      toast('订阅链接已复制到剪贴板', 'success');
    } catch {
      // Fallback for non-HTTPS
      const input = document.createElement('input');
      input.value = url;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      toast('订阅链接已复制', 'success');
    }
  } else if (action === 'delete') {
    const path = btn.dataset.path;

    if (!confirm(`确定删除链接「/sub/${path}」吗？此操作不可恢复。`)) return;

    btn.disabled = true;
    try {
      await apiDeleteLink(path);
      toast('链接已删除', 'success');
      // Optimistic: immediately remove from UI
      removeLinkFromTable(path);
      // Remember it so the sync won't re-add it if the server list
      // still shows it (deletion lag).
      optimisticDeleted.set(path, Date.now());
      // Then sync with server after a short delay (merge mode)
      setTimeout(() => loadLinks(true), 500);
    } catch (err) {
      toast('删除失败：' + err.message, 'error');
      btn.disabled = false;
    }
  }
}

function formatDate(timestamp) {
  if (!timestamp) return '-';
  const d = new Date(timestamp);
  const now = new Date();
  const diff = now - d;

  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 86400000)} 小时前`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} 天前`;

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

// ─── Init ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  $('#convertForm').addEventListener('submit', handleSubmit);
  $('#authForm').addEventListener('submit', handleAuthSubmit);
  $('#btnLogout').addEventListener('click', handleLogout);

  const isAuthOk = await checkAuthStatus();
  if (isAuthOk) {
    loadLinks();
  }
});
