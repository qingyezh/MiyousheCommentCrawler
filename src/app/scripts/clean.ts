import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, projectRootFrom } from '../../config/loader.js';
import { rotateHistory } from '../../logger/index.js';

const projectRoot = projectRootFrom(import.meta.url);
const config = loadConfig(projectRoot);
const dataDir = path.isAbsolute(config.io.dataDir) ? config.io.dataDir : path.join(projectRoot, config.io.dataDir);
const logDir = path.isAbsolute(config.io.logDir) ? config.io.logDir : path.join(projectRoot, config.io.logDir);

const mode = process.argv[2] ?? 'logs';

if (mode === 'logs') {
  rotateHistory(logDir, config.log.historyDays);
  console.log(`已按 historyDays=${config.log.historyDays} 轮转日志 -> ${path.join(logDir, 'history')}`);
} else if (mode === 'data') {
  const target = path.join(dataDir, 'checkpoint.json');
  fs.rmSync(target, { force: true });
  console.log('已删除 checkpoint；如需清批次请自行删除 app/data/runs/*');
} else if (mode === 'all') {
  rotateHistory(logDir, config.log.historyDays);
  console.log('已轮转日志。data 未自动删除以免误伤结果。');
} else {
  console.log('用法: pnpm run clean:data -- logs|data|all');
}
