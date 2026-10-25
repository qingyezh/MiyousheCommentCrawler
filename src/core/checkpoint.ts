import fsp from 'node:fs/promises';
import path from 'node:path';
import { sleep } from './rate.js';
import type { Checkpoint } from '../types.js';

export class CheckpointStore {
  constructor(private file: string) {}

  get path() {
    return this.file;
  }

  async load(): Promise<Checkpoint | null> {
    try {
      const text = await fsp.readFile(this.file, 'utf8');
      return JSON.parse(text) as Checkpoint;
    } catch {
      return null;
    }
  }

  async save(cp: Checkpoint): Promise<void> {
    cp.updatedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const payload = JSON.stringify(cp, null, 2);
    const tmp = `${this.file}.${process.pid}.tmp`;

    // Windows 上 rename 可能因占用失败：写入 + 重试 rename / 退回直写
    await fsp.writeFile(tmp, payload, 'utf8');
    let lastErr: unknown;
    for (let i = 0; i < 5; i++) {
      try {
        await fsp.rename(tmp, this.file);
        return;
      } catch (e) {
        lastErr = e;
        // 尝试覆盖式写入
        try {
          await fsp.writeFile(this.file, payload, 'utf8');
          await fsp.rm(tmp, { force: true });
          return;
        } catch (e2) {
          lastErr = e2;
          await sleep(50 * (i + 1));
        }
      }
    }
    throw lastErr;
  }

  async clear(): Promise<void> {
    await fsp.rm(this.file, { force: true });
  }
}
