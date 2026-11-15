import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './events.mjs';

async function ensureParent(file) {
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
}

export async function appendJsonl(file, record) {
  await ensureParent(file);
  const handle = await fs.open(file, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(redactSecrets(record))}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteJson(file, value) {
  const absolute = path.resolve(file);
  await ensureParent(absolute);
  const temporary = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(redactSecrets(value), null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, absolute);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function readJsonl(file) {
  let contents;
  try {
    contents = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
