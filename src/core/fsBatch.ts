import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Logger } from 'pino';

export interface BatchWriterOptions<T> {
  dir: string;
  batchSize: number;
  flushIntervalMs: number;
  logger: Logger;
  kind: string;
  serialize: (item: T) => string;
}

/**
 * 分批缓冲 + 定时 flush 到 jsonl 文件。
 * 文件命名: {kind}-batch-{seq}.jsonl
 */
export class BatchWriter<T> {
  private buffer: string[] = [];
  private seq = 0;
  private written = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private currentFile: string | null = null;

  constructor(private opts: BatchWriterOptions<T>) {
    fs.mkdirSync(opts.dir, { recursive: true });
    // 续爬：从已有批次最大序号继续，避免覆盖
    const existing = this.listFiles();
    if (existing.length) {
      let maxSeq = 0;
      for (const f of existing) {
        const m = path.basename(f).match(/(\d+)\.jsonl$/);
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
      }
      this.seq = maxSeq;
    }
  }

  write(item: T) {
    if (this.closed) throw new Error('BatchWriter closed');
    this.buffer.push(this.opts.serialize(item));
    if (this.buffer.length >= this.opts.batchSize) {
      void this.flush();
    }
  }

  async startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.opts.flushIntervalMs);
    this.timer.unref?.();
  }

  get writtenCount() {
    return this.written;
  }

  get pendingCount() {
    return this.buffer.length;
  }

  listFiles(): string[] {
    if (!fs.existsSync(this.opts.dir)) return [];
    return fs
      .readdirSync(this.opts.dir)
      .filter((f) => f.startsWith(`${this.opts.kind}-batch-`) && f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(this.opts.dir, f));
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const chunk = this.buffer.splice(0, this.buffer.length);
    this.seq += 1;
    const file = path.join(this.opts.dir, `${this.opts.kind}-batch-${String(this.seq).padStart(5, '0')}.jsonl`);
    const payload = chunk.join('\n') + '\n';
    await fsp.appendFile(file, payload, 'utf8');
    this.currentFile = file;
    this.written += chunk.length;
    this.opts.logger.info({
      kind: this.opts.kind,
      batch: this.seq,
      file: path.basename(file),
      count: chunk.length,
      totalWritten: this.written,
      msg: 'batch_flushed',
    });
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.closed = true;
  }

  async purge(): Promise<void> {
    await this.close();
    for (const f of this.listFiles()) {
      await fsp.rm(f, { force: true });
    }
    this.opts.logger.info({ kind: this.opts.kind, msg: 'batch_purged' });
  }

  /** 读取所有批次并逐行回调（流式） */
  async *iterate(onLine: (line: string) => void): AsyncGenerator<void> {
    const files = this.listFiles();
    for (const file of files) {
      const rl = readline.createInterface({
        input: fs.createReadStream(file, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line.trim()) continue;
        onLine(line);
        yield;
      }
      rl.close();
    }
  }
}

/** 将多批 comments 合并为单一 jsonl（流式，不整包进内存） */
export async function mergeBatchesToFinal(
  batchFiles: string[],
  finalPath: string,
  logger: Logger,
  label: string,
): Promise<number> {
  await fsp.mkdir(path.dirname(finalPath), { recursive: true });
  const out = fs.createWriteStream(finalPath, { encoding: 'utf8' });
  let n = 0;
  for (const file of batchFiles) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      out.write(line.endsWith('\n') ? line : line + '\n');
      n++;
    }
    rl.close();
  }
  await new Promise<void>((resolve, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
  logger.info({ label, lines: n, finalPath, msg: 'merge_done' });
  return n;
}
