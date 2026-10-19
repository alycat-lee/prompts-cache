import {
    getRootHandle,
    ensurePermission,
    pickDirectory,
    scanPromptFiles,
    scanPromptFileHandles,
    readIndex,
    writeIndex,
    writePromptFile,
    deletePromptFile,
    fileExists,
  } from './lib/fs.js';
  import { parseFrontmatter } from './lib/frontmatter.js';
  
  const $ = (selector) => document.querySelector(selector);
  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
  
  const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;
  
  const els = {
    search: $('#search'),
    newBtn: $('#btn-new'),
    refreshBtn: $('#btn-refresh'),
    importBtn: $('#btn-import'),
    category: $('#category'),
    tagbar: $('#tagbar'),
    list: $('#list'),
    status: $('#status'),
    setup: $('#setup'),
    setupMsg: $('#setup-msg'),
    pickBtn: $('#btn-pick'),
    editor: $('#editor'),
    form: $('#editor-form'),
    cancelBtn: $('#btn-cancel'),
    copyDialog: $('#copy-dialog'),
    copyForm: $('#copy-form'),
    copyVars: $('#copy-vars'),
    copyCancel: $('#btn-copy-cancel'),
    copyRaw: $('#btn-copy-raw'),
  };
  
  const fields = {
    name: els.form.elements.namedItem('name'),
    path: els.form.elements.namedItem('path'),
    tags: els.form.elements.namedItem('tags'),
    category: els.form.elements.namedItem('category'),
    content: els.form.elements.namedItem('content'),
  };
  
  const state = {
    root: null,
    prompts: [],
    index: {},
    query: '',
    activeCategory: '',
    activeTags: new Set(),
    editing: null,
    copyPrompt: null,
    copyVars: [],
    statusTimer: null,
    fileObserver: null,
    pollingTimer: null,
    autoRefreshTimer: null,
    pollingSnapshot: new Map(),
  };
  
  function applyI18n() {
    document.documentElement.lang = chrome.i18n.getUILanguage().replace('_', '-');
    document.title = t('extName');
  
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.dataset.i18nTitle);
    });
  }
  
  function setStatus(message, isError = false) {
    els.status.textContent = message || '';
    els.status.classList.toggle('error', isError);
    clearTimeout(state.statusTimer);
    if (message) {
      state.statusTimer = setTimeout(() => {
        els.status.textContent = '';
      }, 2500);
    }
  }
  
  function showSetup(message) {
    els.setupMsg.textContent = message;
    els.setup.hidden = false;
    els.list.innerHTML = '';
    els.tagbar.innerHTML = '';
    els.category.innerHTML = `<option value="">${escapeHtml(t('categoryAll'))}</option>`;
  }
  
  function hideSetup() {
    els.setup.hidden = true;
  }
  
  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[ch]));
  }
  
  function escapeAttr(value) {
    return escapeHtml(value);
  }
  
  // ---------- 自动监听 ----------
  
  function stopAutoWatch() {
    if (state.fileObserver) {
      try { state.fileObserver.disconnect(); } catch {}
      state.fileObserver = null;
    }
    if (state.pollingTimer) {
      clearInterval(state.pollingTimer);
      state.pollingTimer = null;
    }
    if (state.autoRefreshTimer) {
      clearTimeout(state.autoRefreshTimer);
      state.autoRefreshTimer = null;
    }
  }
  
  function scheduleAutoRefresh() {
    if (state.autoRefreshTimer) clearTimeout(state.autoRefreshTimer);
    state.autoRefreshTimer = setTimeout(async () => {
      state.autoRefreshTimer = null;
      await refresh({ silent: true });
    }, 500);
  }
  
  async function startAutoWatch() {
    stopAutoWatch();
    if (!state.root) return;
  
    if (typeof FileSystemObserver !== 'undefined') {
      try {
        state.fileObserver = new FileSystemObserver(() => scheduleAutoRefresh());
        await state.fileObserver.observe(state.root, { recursive: true });
        return;
      } catch (err) {
        console.warn('FileSystemObserver 初始化失败，回退到轮询:', err);
        state.fileObserver = null;
      }
    }
  
    state.pollingSnapshot = new Map(state.prompts.map((p) => [p.path, p.mtime]));
  
    state.pollingTimer = setInterval(async () => {
      if (!state.root || document.visibilityState !== 'visible') return;
      try {
        const handles = await scanPromptFileHandles(state.root);
        const nextMap = new Map();
        for (const item of handles) nextMap.set(item.path, item.mtime);
  
        let changed = nextMap.size !== state.pollingSnapshot.size;
        if (!changed) {
          for (const [path, mtime] of nextMap) {
            if (state.pollingSnapshot.get(path) !== mtime) {
              changed = true;
              break;
            }
          }
        }
        if (changed) {
          state.pollingSnapshot = nextMap;
          scheduleAutoRefresh();
        }
      } catch (err) {
        // 静默
      }
    }, 3000);
  }
  
  window.addEventListener('pagehide', stopAutoWatch);
  
  // ---------- 初始化 ----------
  
  async function init() {
    try {
      state.root = await getRootHandle();
  
      if (!state.root) {
        showSetup(t('setupFirst'));
        return;
      }
  
      if (!(await ensurePermission(state.root, false))) {
        showSetup(t('setupReauth'));
        return;
      }
  
      hideSetup();
      await refresh();
      await startAutoWatch();
    } catch (err) {
      console.error(err);
      showSetup(t('statusInitFailed', [err.message || String(err)]));
    }
  }
  
  async function handlePick() {
    try {
      if (state.root) {
        const granted = await ensurePermission(state.root, true);
        if (granted) {
          hideSetup();
          await refresh();
          await startAutoWatch();
          setStatus(t('statusRestored'));
          return;
        }
      }
  
      state.root = await pickDirectory();
      hideSetup();
      await refresh();
      await startAutoWatch();
      setStatus(t('statusFolderConnected'));
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error(err);
      setStatus(t('statusFolderFailed', [err.message || String(err)]), true);
    }
  }
  
  // ---------- 扫描与索引 ----------
  
  async function refresh({ silent = false } = {}) {
    if (!state.root) return;
  
    try {
      const files = await scanPromptFiles(state.root);
      state.index = await readIndex(state.root);
  
      state.prompts = files.map((file) => {
        const { meta, body } = parseFrontmatter(file.text);
        const extra = state.index[file.path] || {};
  
        const tags = Array.isArray(extra.tags)
          ? [...new Set(extra.tags.map((x) => String(x).trim()).filter(Boolean))]
          : [];
  
        return {
          path: file.path,
          filename: file.name,
          name: (meta.name && String(meta.name).trim()) || file.name.replace(/\.md$/i, ''),
          content: body.trim(),
          tags,
          category: String(extra.category || '').trim(),
          mtime: file.mtime,
        };
      });
  
      state.pollingSnapshot = new Map(state.prompts.map((p) => [p.path, p.mtime]));
  
      render();
      if (!silent) setStatus(t('statusLoaded', [String(state.prompts.length)]));
    } catch (err) {
      console.error(err);
      setStatus(t('statusRefreshFailed', [err.message || String(err)]), true);
    }
  }
  
  async function importIndex() {
    if (!state.root) return;
  
    try {
      const handles = await scanPromptFileHandles(state.root);
      const index = await readIndex(state.root);
  
      let added = 0;
      for (const item of handles) {
        if (!index[item.path]) {
          index[item.path] = { tags: [], category: '' };
          added++;
        }
      }
  
      if (added) {
        await writeIndex(state.root, index);
        setStatus(t('statusIndexed', [String(added)]));
      } else {
        setStatus(t('statusIndexedNone'));
      }
  
      await refresh({ silent: true });
    } catch (err) {
      console.error(err);
      setStatus(t('statusRefreshFailed', [err.message || String(err)]), true);
    }
  }
  
  // ---------- 筛选与渲染 ----------
  
  function collectCategories() {
    return [...new Set(state.prompts.map((p) => p.category).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }
  
  function collectTags() {
    return [...new Set(state.prompts.flatMap((p) => p.tags))]
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }
  
  function matches(prompt) {
    const query = state.query.trim().toLowerCase();
  
    if (state.activeCategory && prompt.category !== state.activeCategory) return false;
    for (const tag of state.activeTags) {
      if (!prompt.tags.includes(tag)) return false;
    }
    if (!query) return true;
  
    const haystack = [
      prompt.name,
      prompt.path,
      prompt.category,
      ...prompt.tags,
      prompt.content,
    ].join('\n').toLowerCase();
  
    return haystack.includes(query);
  }
  
  function render() {
    const categories = collectCategories();
    if (state.activeCategory && !categories.includes(state.activeCategory)) {
      state.activeCategory = '';
    }
  
    els.category.innerHTML =
      `<option value="">${escapeHtml(t('categoryAll'))}</option>` +
      categories
        .map((category) => {
          const selected = category === state.activeCategory ? ' selected' : '';
          return `<option value="${escapeAttr(category)}"${selected}>${escapeHtml(category)}</option>`;
        })
        .join('');
  
    const tags = collectTags();
    els.tagbar.innerHTML =
      `<button type="button" class="chip${state.activeTags.size ? '' : ' on'}" data-tag="">${escapeHtml(t('tagAll'))}</button>` +
      tags
        .map((tag) => {
          const on = state.activeTags.has(tag) ? ' on' : '';
          return `<button type="button" class="chip${on}" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`;
        })
        .join('');
  
    const visible = state.prompts.filter(matches);
  
    if (!visible.length) {
      els.list.innerHTML = `<p class="empty">${escapeHtml(t('emptyList'))}</p>`;
      return;
    }
  
    els.list.innerHTML = visible
      .map((prompt) => {
        const tagHtml = prompt.tags.length
          ? `<div class="tags">${prompt.tags
              .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
              .join('')}</div>`
          : '';
  
        const categoryHtml = prompt.category
          ? `<span class="category">${escapeHtml(prompt.category)}</span>`
          : '';
  
        return `
          <article class="card" data-path="${escapeAttr(prompt.path)}">
            <h3>${escapeHtml(prompt.name)}</h3>
            <div class="sub">
              <span class="filename">${escapeHtml(prompt.path)}</span>
              ${categoryHtml}
            </div>
            ${tagHtml}
            <div class="ops">
              <button type="button" data-act="copy">${escapeHtml(t('btnCopy'))}</button>
              <button type="button" data-act="edit">${escapeHtml(t('btnEdit'))}</button>
              <button type="button" data-act="delete">${escapeHtml(t('btnDelete'))}</button>
            </div>
          </article>
        `;
      })
      .join('');
  }
  
  // ---------- 复制与变量 ----------
  
  function extractVars(text) {
    const set = new Set();
    for (const match of text.matchAll(VAR_RE)) set.add(match[1].trim());
    return [...set];
  }
  
  async function doCopy(text, name) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t('statusCopied', [name]));
      return;
    } catch (err) {
      console.warn('navigator.clipboard 失败，尝试回退方案:', err);
    }
  
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
  
    const ok = document.execCommand('copy');
    textarea.remove();
  
    setStatus(ok ? t('statusCopied', [name]) : t('statusCopyFailed'), !ok);
  }
  
  async function copyPrompt(prompt) {
    const vars = extractVars(prompt.content);
    if (!vars.length) {
      await doCopy(prompt.content, prompt.name);
      return;
    }
  
    state.copyPrompt = prompt;
    state.copyVars = vars;
    els.copyVars.innerHTML = vars
      .map((name) => `
        <label>
          <span>${escapeHtml(name)}</span>
          <input data-var-name="${escapeAttr(name)}" autocomplete="off">
        </label>
      `)
      .join('');
    els.copyDialog.showModal();
    setTimeout(() => els.copyVars.querySelector('input')?.focus(), 0);
  }
  
  // ---------- 编辑 ----------
  
  function sanitizeRelPath(input) {
    const trimmed = String(input || '').trim().replace(/\\/g, '/');
    if (!trimmed) return '';
    if (trimmed.startsWith('/')) return '';
  
    const segments = trimmed.split('/').map((s) => s.trim()).filter(Boolean);
    for (const seg of segments) {
      if (seg === '.' || seg === '..') return '';
      if (/[<>:"|?*\x00-\x1f]/.test(seg)) return '';
    }
    return segments.join('/');
  }
  
  function sanitizeFilenameFromName(name) {
    const base = String(name)
      .trim()
      .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
      .replace(/\s+/g, '-')
      .replace(/^[.]+|[.]+$/g, '')
      .replace(/^-+|-+$/g, '');
    return base || 'prompt';
  }
  
  function openEditor(prompt) {
    state.editing = prompt || null;
  
    fields.name.value = prompt ? prompt.name : '';
    fields.path.value = prompt ? prompt.path : '';
    fields.tags.value = prompt ? prompt.tags.join(', ') : '';
    fields.category.value = prompt ? prompt.category : '';
    fields.content.value = prompt ? prompt.content : '';
  
    els.editor.showModal();
    setTimeout(() => fields.name.focus(), 0);
  }
  
  async function saveEditor() {
    if (!state.root) return;
  
    const name = fields.name.value.trim();
    const content = fields.content.value.trim();
  
    if (!name || !content) {
      setStatus(t('statusNameContentRequired'), true);
      return;
    }
  
    let relPath = sanitizeRelPath(fields.path.value);
    if (!relPath) relPath = sanitizeFilenameFromName(name);
    if (!/\.md$/i.test(relPath)) relPath += '.md';
  
    const segments = relPath.split('/');
    const filename = segments.pop();
    if (!filename || filename.startsWith('.')) {
      setStatus(t('statusFilenameInvalid'), true);
      return;
    }
  
    const normalized = [...segments, filename].join('/');
    const oldPath = state.editing ? state.editing.path : null;
  
    if (normalized !== oldPath && (await fileExists(state.root, normalized))) {
      setStatus(t('statusFileExists', [normalized]), true);
      return;
    }
  
    const tags = fields.tags.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const category = fields.category.value.trim();
  
    try {
      await writePromptFile(state.root, normalized, name, content);
  
      if (oldPath && oldPath !== normalized) {
        await deletePromptFile(state.root, oldPath);
      }
  
      const index = await readIndex(state.root);
      if (oldPath && oldPath !== normalized) delete index[oldPath];
      index[normalized] = { tags, category };
      await writeIndex(state.root, index);
  
      els.editor.close();
      setStatus(t('statusSaved', [normalized]));
      await refresh();
    } catch (err) {
      console.error(err);
      setStatus(t('statusSaveFailed', [err.message || String(err)]), true);
    }
  }
  
  async function deletePrompt(prompt) {
    if (!state.root) return;
    if (!confirm(t('confirmDelete', [prompt.path]))) return;
  
    try {
      await deletePromptFile(state.root, prompt.path);
  
      const index = await readIndex(state.root);
      if (index[prompt.path]) {
        delete index[prompt.path];
        await writeIndex(state.root, index);
      }
  
      setStatus(t('statusDeleted', [prompt.path]));
      await refresh();
    } catch (err) {
      console.error(err);
      setStatus(t('statusDeleteFailed', [err.message || String(err)]), true);
    }
  }
  
  // ---------- 事件绑定 ----------
  
  els.list.addEventListener('click', async (event) => {
    const card = event.target.closest('.card');
    if (!card) return;
  
    const prompt = state.prompts.find((item) => item.path === card.dataset.path);
    if (!prompt) return;
  
    const action = event.target.closest('button')?.dataset.act;
  
    if (!action || action === 'copy') {
      await copyPrompt(prompt);
      return;
    }
    if (action === 'edit') {
      openEditor(prompt);
      return;
    }
    if (action === 'delete') {
      await deletePrompt(prompt);
    }
  });
  
  els.search.addEventListener('input', (event) => {
    state.query = event.target.value;
    render();
  });
  
  els.category.addEventListener('change', (event) => {
    state.activeCategory = event.target.value;
    render();
  });
  
  els.tagbar.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
  
    const tag = chip.dataset.tag;
    if (!tag) state.activeTags.clear();
    else if (state.activeTags.has(tag)) state.activeTags.delete(tag);
    else state.activeTags.add(tag);
  
    render();
  });
  
  els.newBtn.addEventListener('click', () => openEditor(null));
  els.refreshBtn.addEventListener('click', () => refresh());
  els.importBtn.addEventListener('click', importIndex);
  els.pickBtn.addEventListener('click', handlePick);
  els.cancelBtn.addEventListener('click', () => els.editor.close());
  
  els.form.addEventListener('submit', (event) => {
    event.preventDefault();
    saveEditor();
  });
  
  els.copyCancel.addEventListener('click', () => {
    state.copyPrompt = null;
    state.copyVars = [];
    els.copyDialog.close();
  });
  
  els.copyRaw.addEventListener('click', async () => {
    const prompt = state.copyPrompt;
    if (!prompt) return;
    state.copyPrompt = null;
    state.copyVars = [];
    els.copyDialog.close();
    await doCopy(prompt.content, prompt.name);
  });
  
  els.copyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const prompt = state.copyPrompt;
    if (!prompt) return;
  
    const values = {};
    els.copyVars.querySelectorAll('input[data-var-name]').forEach((input) => {
      values[input.dataset.varName] = input.value;
    });
  
    const filled = prompt.content.replace(VAR_RE, (_, raw) => {
      const key = raw.trim();
      const value = values[key];
      return value !== undefined && value !== '' ? value : `{{${key}}}`;
    });
  
    state.copyPrompt = null;
    state.copyVars = [];
    els.copyDialog.close();
  
    await doCopy(filled, prompt.name);
  });
  
  applyI18n();
  init();