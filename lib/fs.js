export const INDEX_FILENAME = '.prompts-cache.json';

const DB_NAME = 'prompts-cache';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
const ROOT_KEY = 'root';

let dbPromise = null;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function kvGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kvSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function getRootHandle() {
  return kvGet(ROOT_KEY);
}

export function saveRootHandle(handle) {
  return kvSet(ROOT_KEY, handle);
}

export async function ensurePermission(handle, request = false) {
  const options = { mode: 'readwrite' };
  if ((await handle.queryPermission(options)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(options)) === 'granted';
}

export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({
    mode: 'readwrite',
    id: 'prompts-cache',
  });
  await saveRootHandle(handle);
  await ensurePermission(handle, true);
  return handle;
}

async function getDirHandleFromPath(root, relDir, { create = false } = {}) {
  const parts = String(relDir || '').split('/').filter(Boolean);
  let dir = root;
  for (const part of parts) {
    if (part === '.' || part === '..') throw new Error('非法的路径片段');
    dir = await dir.getDirectoryHandle(part, { create });
  }
  return dir;
}

export async function scanPromptFileHandles(root, basePath = '') {
  const entries = [];
  for await (const [name, handle] of root.entries()) {
    if (name.startsWith('.')) continue;
    const relPath = basePath ? `${basePath}/${name}` : name;

    if (handle.kind === 'directory') {
      try {
        const sub = await scanPromptFileHandles(handle, relPath);
        entries.push(...sub);
      } catch (err) {
        console.warn('读取子目录失败，已跳过:', relPath, err);
      }
      continue;
    }

    if (handle.kind !== 'file') continue;
    if (!/\.md$/i.test(name)) continue;

    try {
      const file = await handle.getFile();
      entries.push({
        path: relPath,
        name,
        handle,
        mtime: file.lastModified,
        size: file.size,
      });
    } catch (err) {
      console.warn('读取文件元数据失败，已跳过:', relPath, err);
    }
  }
  return entries;
}

export async function scanPromptFiles(root) {
  const handles = await scanPromptFileHandles(root);
  const files = [];

  for (const item of handles) {
    try {
      const file = await item.handle.getFile();
      files.push({
        path: item.path,
        name: item.name,
        text: await file.text(),
        mtime: item.mtime,
        size: item.size,
      });
    } catch (err) {
      console.warn('读取文件失败，已跳过:', item.path, err);
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path, 'zh-Hans-CN'));
  return files;
}

export async function readIndex(root) {
  try {
    const handle = await root.getFileHandle(INDEX_FILENAME);
    const file = await handle.getFile();
    const text = await file.text();
    if (!text.trim()) return {};

    const data = JSON.parse(text);
    if (data && typeof data.items === 'object' && data.items !== null) {
      return data.items;
    }
    return {};
  } catch (err) {
    if (err && err.name === 'NotFoundError') return {};
    console.warn('读取索引失败，按空索引处理:', err);
    return {};
  }
}

export async function writeIndex(root, items) {
  const handle = await root.getFileHandle(INDEX_FILENAME, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({ version: 1, items }, null, 2));
  await writable.close();
}

export async function writePromptFile(root, relPath, name, content) {
  const parts = String(relPath).split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) throw new Error('文件名为空');

  const dir = parts.length
    ? await getDirHandleFromPath(root, parts.join('/'), { create: true })
    : root;

  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();

  const safeName = String(name).replace(/\r?\n/g, ' ').trim();
  const nameLine = /[:#"'{}[\],&*?|<>=!%@`]/.test(safeName)
    ? JSON.stringify(safeName)
    : safeName;

  await writable.write(
    `---\nname: ${nameLine}\n---\n\n${String(content).trim()}\n`
  );
  await writable.close();
}

export async function deletePromptFile(root, relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) return;

  const dir = parts.length
    ? await getDirHandleFromPath(root, parts.join('/'))
    : root;

  await dir.removeEntry(filename);
}

export async function fileExists(root, relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  const filename = parts.pop();
  if (!filename) return false;

  try {
    const dir = parts.length
      ? await getDirHandleFromPath(root, parts.join('/'))
      : root;
    await dir.getFileHandle(filename);
    return true;
  } catch {
    return false;
  }
}