/*
 * Shared workspace for multiple Chrome profiles.
 * Each profile grants access to the same physical folder once. Project snapshots
 * are then exchanged through _EbookAuto/projects while IndexedDB remains the
 * fast local cache used by the editor/compiler.
 */
import * as db from './db.js';

const ROOT = '_EbookAuto';
const PROJECTS = 'projects';
const WORKSPACE_INFO = 'workspace.json';
let directoryHandle = null;

export function setDirectoryHandle(handle) {
  directoryHandle = handle || null;
}

export async function restoreDirectoryHandle() {
  if (directoryHandle) return directoryHandle;
  const handle = await db.setting('exportDirectory');
  if (!handle || typeof handle.queryPermission !== 'function') return null;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') return null;
    directoryHandle = handle;
    return handle;
  } catch {
    return null;
  }
}

export async function useDirectoryHandle(handle) {
  if (!handle) return null;
  directoryHandle = handle;
  await db.setting('exportDirectory', handle);
  await ensureWorkspaceInfo();
  return handle;
}

export async function hasWorkspace() {
  return !!(await restoreDirectoryHandle());
}

async function appDir({ create = false } = {}) {
  const root = await restoreDirectoryHandle();
  if (!root) return null;
  try {
    return await root.getDirectoryHandle(ROOT, { create });
  } catch {
    return null;
  }
}

async function projectsDir({ create = false } = {}) {
  const app = await appDir({ create });
  if (!app) return null;
  try {
    return await app.getDirectoryHandle(PROJECTS, { create });
  } catch {
    return null;
  }
}

/**
 * Persistent identity of the physical folder. Two Chrome profiles that really
 * selected the same folder will see the same workspace id. This also makes it
 * easy to diagnose accidentally selecting two different folders with the same name.
 */
export async function ensureWorkspaceInfo() {
  const app = await appDir({ create: true });
  if (!app) return null;
  try {
    const info = await readJsonFile(app, WORKSPACE_INFO);
    if (info?.id) return info;
  } catch {}

  const info = {
    version: 1,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  await writeFile(app, WORKSPACE_INFO, JSON.stringify(info));
  await projectsDir({ create: true });
  return info;
}

export async function getWorkspaceInfo() {
  const app = await appDir({ create: false });
  if (!app) return null;
  try {
    return await readJsonFile(app, WORKSPACE_INFO);
  } catch {
    return null;
  }
}

async function writeFile(dir, name, data, type = 'application/json') {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data instanceof Blob ? data : new Blob([data], { type }));
  await w.close();
}

async function readJsonFile(dir, name) {
  const fh = await dir.getFileHandle(name);
  const file = await fh.getFile();
  return JSON.parse(await file.text());
}

const projectName = (id) => `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.project.json`;
const metaName = (id) => `${String(id).replace(/[^a-zA-Z0-9_-]/g, '_')}.meta.json`;

function summarize(book, sectionCount = 0) {
  const required = Number(book.imagePhase?.total) || 0;
  const remaining = Array.isArray(book.imagePhase?.remaining)
    ? book.imagePhase.remaining.length
    : Math.max(0, required - (Number(book.imagePhase?.completed) || 0));
  return {
    version: 1,
    id: book.id,
    title: book.outline?.title || book.topic || '(ยังไม่มีชื่อ)',
    topic: book.topic || '',
    updatedAt: Number(book.updatedAt) || Date.now(),
    targetPages: book.targetPages || null,
    finalPages: book.finalPages || null,
    sectionCount,
    contentMode: book.contentMode || 'prose',
    job: {
      step: book.job?.step || null,
      status: book.job?.status || null,
    },
    imagePhase: {
      status: book.imagePhase?.status || null,
      total: required,
      remaining,
      completed: Math.max(0, required - remaining),
    },
  };
}

/** Write a complete project snapshot plus a small metadata file for fast history listing. */
export async function syncProject(bookId) {
  const dir = await projectsDir({ create: true });
  if (!dir) return { ok: false, reason: 'workspace_unavailable' };
  const payload = await db.exportProject(bookId);
  if (!payload?.book) return { ok: false, reason: 'project_not_found' };
  const meta = summarize(payload.book, payload.sections?.length || 0);
  const json = JSON.stringify({ ...payload, workspaceMeta: meta });
  await writeFile(dir, projectName(bookId), json);
  await writeFile(dir, metaName(bookId), JSON.stringify(meta));
  return { ok: true, meta };
}

/** Read lightweight metadata from the physical shared folder. */
export async function listProjects() {
  const root = await restoreDirectoryHandle();
  if (!root) return [];
  await ensureWorkspaceInfo();
  const dir = await projectsDir({ create: true });
  if (!dir) return [];
  const out = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.endsWith('.meta.json')) continue;
      try {
        const file = await handle.getFile();
        const meta = JSON.parse(await file.text());
        if (meta?.id) out.push(meta);
      } catch {}
    }
  } catch {}
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * Publish legacy/local-only projects into the shared folder without overwriting
 * a newer snapshot created by another Chrome profile.
 */
export async function mergeLocalProjectsToWorkspace() {
  const info = await ensureWorkspaceInfo();
  if (!info) return { ok: false, published: 0, shared: 0 };

  const [locals, shared] = await Promise.all([db.listBooks(), listProjects()]);
  const sharedById = new Map(shared.map((m) => [m.id, m]));
  let published = 0;

  for (const local of locals) {
    const remote = sharedById.get(local.id);
    const localUpdated = Number(local.updatedAt) || 0;
    const remoteUpdated = Number(remote?.updatedAt) || 0;
    if (!remote || localUpdated >= remoteUpdated) {
      const r = await syncProject(local.id);
      if (r?.ok) published++;
    }
  }

  const metas = await listProjects();
  return { ok: true, published, shared: metas.length, workspaceId: info.id };
}

/**
 * Remove a project from the shared folder.
 * Deleting only the local IndexedDB copy is not enough: the history list also reads
 * the shared *.meta.json files, so the row would reappear on the next refresh.
 */
export async function deleteProject(bookId) {
  const dir = await projectsDir({ create: false });
  if (!dir) return { ok: false, reason: 'workspace_unavailable' };
  let removed = 0;
  for (const name of [projectName(bookId), metaName(bookId)]) {
    try {
      await dir.removeEntry(name);
      removed++;
    } catch {}
  }
  return { ok: true, removed };
}

/**
 * โฟลเดอร์รับรูปของโครงการ — ที่ที่ผู้ใช้เอาไฟล์รูปมาวางเองได้
 *
 * เส้นทางเดิมพึ่ง "คว้าภาพจากหน้าเว็บให้ทันก่อนแชตจะเปลี่ยน" อย่างเดียว
 * ซึ่งเป็นการแข่งกับเวลาที่แพ้ได้เสมอ โฟลเดอร์ไม่มีเงื่อนเวลา ไฟล์วางไว้เมื่อไรก็ได้
 * สร้างรูปที่ไหนก็ได้ ตั้งชื่อให้ตรงช่อง แล้วโยนลงโฟลเดอร์ ระบบมาเก็บเองทีหลัง
 */
export async function imagesDir(bookId, { create = false } = {}) {
  const app = await appDir({ create });
  if (!app) return null;
  try {
    const dir = await app.getDirectoryHandle('images', { create });
    return await dir.getDirectoryHandle(String(bookId).replace(/[^a-zA-Z0-9_-]/g, '_'), { create });
  } catch {
    return null;
  }
}

/** อ่านไฟล์รูปทั้งหมดที่ผู้ใช้วางไว้ในโฟลเดอร์รับรูปของโครงการนี้ */
export async function readDroppedImages(bookId) {
  const dir = await imagesDir(bookId, { create: false });
  if (!dir) return [];
  const out = [];
  try {
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file') continue;
      if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
      try {
        const file = await handle.getFile();
        if (file.size) out.push({ name, blob: file, lastModified: file.lastModified || 0 });
      } catch {}
    }
  } catch {}
  return out;
}

/** ลบไฟล์ที่เก็บเข้าระบบแล้ว เพื่อไม่ให้ถูกหยิบซ้ำในรอบถัดไป */
export async function removeDroppedImage(bookId, name) {
  const dir = await imagesDir(bookId, { create: false });
  if (!dir) return false;
  try {
    await dir.removeEntry(name);
    return true;
  } catch {
    return false;
  }
}

/** Import/refresh one shared project into this Chrome profile's IndexedDB cache. */
export async function importProject(bookId) {
  const dir = await projectsDir({ create: false });
  if (!dir) throw new Error('ยังไม่ได้เลือก Shared Workspace ใน Chrome profile นี้');
  const payload = await readJsonFile(dir, projectName(bookId));
  if (!payload?.book?.id) throw new Error('ไฟล์โครงการใน Shared Workspace ไม่สมบูรณ์');
  await db.importProject(payload);
  return payload.book.id;
}

export async function getSharedMeta(bookId) {
  const dir = await projectsDir({ create: false });
  if (!dir) return null;
  try {
    return await readJsonFile(dir, metaName(bookId));
  } catch {
    return null;
  }
}
