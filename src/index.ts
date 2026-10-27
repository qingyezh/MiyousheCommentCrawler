#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, projectRootFrom } from './config/loader.js';
import { createLogger, rotateHistory } from './logger/index.js';
import { runCrawl, runReportOnly, SimpleCrawlController, type CrawlContext } from './pipeline/crawler.js';
import { runAnalysisById, runPartialAnalysis, readPostTitle, writeTitleMarkerFile, resolveResultsDir } from './pipeline/analysis.js';
import { runMonitor } from './pipeline/monitor.js';
import { startControlServer } from './core/control.js';
import type { CrawlOptions } from './types.js';

function parseArgs(argv: string[]) {
  const args = { _: [] as string[], flags: {} as Record<string, string | boolean> };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.flags[key] = next;
        i++;
      } else {
        args.flags[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function num(v: string | boolean | undefined, d?: number): number | undefined {
  if (v === undefined || typeof v === 'boolean') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function str(v: string | boolean | undefined): string | undefined {
  if (v === undefined || typeof v === 'boolean') return undefined;
  return v;
}

/** 解析 --ana true/false/1/0；true 也算开关打开 */
function parseBoolFlag(v: string | boolean | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') return v; // --ana 无值 = true
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'crawl';
  const rest = argv.slice(1);
  const { flags, _ } = parseArgs(rest);

  const projectRoot = projectRootFrom(import.meta.url);
  const config = loadConfig(projectRoot);

  const logLevel = str(flags['log-level']) ?? (flags.verbose ? 'debug' : config.log.level);
  const runId = str(flags['run-id']);
  const logger = createLogger({
    logDir: path.isAbsolute(config.io.logDir)
      ? config.io.logDir
      : path.join(projectRoot, config.io.logDir),
    level: logLevel,
    historyDays: config.log.historyDays,
    timezoneOffsetHours: config.log.timezoneOffsetHours,
    runId,
  });

  rotateHistory(
    path.isAbsolute(config.io.logDir) ? config.io.logDir : path.join(projectRoot, config.io.logDir),
    config.log.historyDays,
    config.log.timezoneOffsetHours,
  );

  logger.info(
    {
      cmd,
      node: process.version,
      cwd: process.cwd(),
      projectRoot,
      logLevel,
      intervals: config.intervals,
      timezone: config.log.timezoneOffset,
      timezoneOffsetHours: config.log.timezoneOffsetHours,
      msg: 'cli_start',
    },
  );

  const dataDir = path.isAbsolute(config.io.dataDir)
    ? config.io.dataDir
    : path.join(projectRoot, config.io.dataDir);

  let controllerRef: SimpleCrawlController | null = null;
  const makeController = (): SimpleCrawlController => {
    const c = new SimpleCrawlController();
    controllerRef = c;
    return c;
  };

  const control =
    config.control.enable || flags['control-port']
      ? await startControlServer(num(flags['control-port'], config.control.port)!, logger, () => controllerRef)
      : null;

  if (cmd === 'crawl' || cmd === 'dev') {
    const posUrl = _[0];
    const resolvedUrl = (str(flags.url) ?? posUrl ?? config.crawl.url ?? '').trim();

    if (!resolvedUrl) {
      logger.error({ msg: 'missing_url' });
      console.error(
        [
          '未配置目标 URL。任选其一：',
          '1) 编辑 app/config/config.yaml 的 crawl.url，然后直接: pnpm run crawl',
          '2) 命令行覆盖: pnpm run crawl -- --url "https://www.miyoushe.com/ys/article/79098964"',
        ].join('\n'),
      );
      process.exit(2);
    }

    const usersFromFlag = flags.users !== undefined;
    const childFromFlag = flags.child !== undefined;
    const maxUsersFlag = num(flags['max-users']);
    const maxPagesFlag = num(flags['max-pages']);

    const options: CrawlOptions = {
      url: resolvedUrl,
      users: usersFromFlag ? Boolean(flags.users) : Boolean(config.crawl.users),
      maxUsers: maxUsersFlag ?? (config.crawl.maxUsers > 0 ? config.crawl.maxUsers : undefined),
      maxRootPages: maxPagesFlag ?? (config.crawl.maxRootPages > 0 ? config.crawl.maxRootPages : undefined),
      purgeBatches:
        flags['purge-batches'] !== undefined
          ? Boolean(flags['purge-batches'])
          : Boolean(config.crawl.purgeBatches),
      verbose: Boolean(flags.verbose),
      logLevel: str(flags['log-level']),
      resumeCheckpoint: str(flags.checkpoint),
      runId: str(flags['run-id']),
      child: childFromFlag ? Boolean(flags.child) : config.crawl.includeChild,
      analysis: parseBoolFlag(flags.ana) ?? Boolean(config.crawl.analysis),
    };

    logger.info(
      {
        url: options.url,
        users: options.users,
        child: options.child,
        maxUsers: options.maxUsers,
        maxRootPages: options.maxRootPages,
        analysis: options.analysis,
        source: str(flags.url) || posUrl ? 'cli' : 'config.crawl',
        msg: 'crawl_options_resolved',
      },
    );

    const controller = makeController();
    const ctx: CrawlContext = { config, logger, projectRoot, options };

    // SIGINT/SIGTERM graceful：主动中止 → checkpoint 暂停 + 退出码 130
    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) process.exit(130);
      stopping = true;
      logger.warn({ sig, msg: 'signal_pause_flush_exit' });
      controller.abort(sig);
      setTimeout(() => {
        logger.error({ msg: 'force_exit_after_signal' });
        process.exit(130);
      }, 15000).unref();
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));

    try {
      await runCrawl(ctx, controller);
    } catch (e) {
      const aborted =
        controller.isAborted ||
        (e instanceof Error && (e.message === 'pool_aborted' || e.message.includes('abort')));
      if (aborted) {
        logger.warn({ msg: 'crawl_paused_use_resume' });
        if (control) await control.close();
        process.exit(130);
      }
      throw e;
    }
    if (control) await control.close();
    logger.info({ msg: 'cli_done' });
    return;
  }

  if (cmd === 'resume') {
    const checkpoint = str(flags.checkpoint) ?? path.join(dataDir, 'checkpoint.json');
    const cpLoaded = str(flags.url);
    const options: CrawlOptions = {
      url: cpLoaded ?? '',
      users: Boolean(flags.users),
      maxUsers: num(flags['max-users']),
      maxRootPages: num(flags['max-pages']),
      purgeBatches: Boolean(flags['purge-batches']),
      verbose: Boolean(flags.verbose),
      resumeCheckpoint: checkpoint,
      runId: str(flags['run-id']),
    };
    // load url from checkpoint if needed
    const fs = await import('node:fs/promises');
    if (!options.url) {
      const raw = JSON.parse(await fs.readFile(checkpoint, 'utf8')) as { url: string; users?: { enabled?: boolean } };
      options.url = raw.url;
      options.users = options.users || Boolean(raw.users?.enabled);
    }
    logger.info({ url: options.url, checkpoint, msg: 'resume_start' });
    const controller = makeController();
    let stopping = false;
    const onSignal = (sig: string) => {
      if (stopping) process.exit(130);
      stopping = true;
      logger.warn({ sig, msg: 'signal_pause_flush_exit' });
      controller.abort(sig);
      setTimeout(() => process.exit(130), 15000).unref();
    };
    process.on('SIGINT', () => onSignal('SIGINT'));
    process.on('SIGTERM', () => onSignal('SIGTERM'));
    try {
      await runCrawl({ config, logger, projectRoot, options }, controller);
    } catch (e) {
      const aborted =
        controller.isAborted ||
        (e instanceof Error && (e.message === 'pool_aborted' || e.message.includes('abort')));
      if (aborted) {
        if (control) await control.close();
        process.exit(130);
      }
      throw e;
    }
    if (control) await control.close();
    return;
  }

  if (cmd === 'report') {
    await runReportOnly({ config, logger, projectRoot, options: { url: '', users: false } });
    if (control) await control.close();
    return;
  }

  if (cmd === 'clean') {
    // 手动清理历史日志
    const logDir = path.isAbsolute(config.io.logDir) ? config.io.logDir : path.join(projectRoot, config.io.logDir);
    rotateHistory(logDir, 0 as number); // force archive all?
    // historyDays 0 would archive everything including today - use config
    rotateHistory(logDir, config.log.historyDays);
    logger.info({ msg: 'clean_logs_done' });
    if (control) await control.close();
    return;
  }

  if (cmd === 'analysis' || cmd === 'ana') {
    const idRaw = str(flags.id) ?? str(flags._ as unknown as string) ?? _[0] ?? config.crawl.url?.split('/').filter(Boolean).pop();
    if (!idRaw) {
      logger.error({ msg: 'missing_analysis_id' });
      console.error('用法: pnpm run analysis -- --id 79085282  或  --id app\\data\\results\\79085282');
      process.exit(2);
    }
    const ana = await runAnalysisById(idRaw, {
      projectRoot,
      dataDir,
      logger,
      levelMin: config.users.levelMin,
    });
    logger.info({
      id: idRaw,
      outDir: ana.outDir,
      uniqueCommenters: ana.uniqueCommenters,
      charts: ana.charts.length,
      msg: 'analysis_cli_done',
    });
    console.log(`分析完成: ${ana.outDir}`);
    console.log(`图表目录: ${path.join(ana.outDir, 'charts')}`);
    if (control) await control.close();
    return;
  }

  if (cmd === 'partial' || cmd === 'snap') {
    const ana = await runPartialAnalysis({
      projectRoot,
      dataDir,
      logger,
      levelMin: config.users.levelMin,
      checkpointPath: str(flags.checkpoint),
    });
    logger.info({
      outDir: ana.outDir,
      uniqueCommenters: ana.uniqueCommenters,
      charts: ana.charts.length,
      msg: 'partial_analysis_cli_done',
    });
    console.log(`中途快照分析完成（未改断点）: ${ana.outDir}`);
    console.log(`图表目录: ${path.join(ana.outDir, 'charts')}`);
    if (control) await control.close();
    return;
  }

  if (cmd === 'monitor' || cmd === 'mon') {
    const posUrl = _[0];
    const url = (str(flags.url) ?? posUrl ?? config.monitor.url ?? config.crawl.url ?? '').trim();
    if (!url) {
      console.error('用法: pnpm run monitor -- --url "https://www.miyoushe.com/ys/article/xxx" [--interval 2]');
      console.error('或在 app/config/config.yaml 的 monitor.url / crawl.url 中配置目标帖');
      process.exit(2);
    }
    const intervalSec = num(flags.interval, config.monitor.intervalSec) ?? config.monitor.intervalSec;
    await runMonitor(
      {
        url,
        intervalMs: Math.round(intervalSec * 1000),
        window: num(flags.window, config.monitor.window) ?? config.monitor.window,
        maxPoints: num(flags.max, config.monitor.maxPoints) ?? config.monitor.maxPoints,
        port: num(flags.port, config.monitor.port) ?? config.monitor.port,
        sparkline: parseBoolFlag(flags.sparkline) ?? config.monitor.sparkline,
      },
      { config, logger, projectRoot },
    );
    if (control) await control.close();
    return;
  }

  if (cmd === 'reset-title' || cmd === 'Reset-Title' || cmd === 'reset_title') {
    const idRaw = str(flags.id) ?? _[0] ?? config.crawl.url?.split('/').filter(Boolean).pop();
    if (!idRaw) {
      console.error('用法: pnpm run Reset-Title -- --id 79085282');
      process.exit(2);
    }
    const resultsDir = resolveResultsDir(idRaw, projectRoot, dataDir);
    const title = str(flags.title) ?? (await readPostTitle(resultsDir));
    if (!title) {
      console.error(`未能从 ${resultsDir} 读取标题，请用 --title "标题" 指定`);
      process.exit(2);
    }
    const file = await writeTitleMarkerFile(resultsDir, title, logger);
    console.log(`标题空文件已重建: ${file}`);
    if (control) await control.close();
    return;
  }

  logger.error({ cmd, msg: 'unknown_cmd' });
  console.error('未知命令。可用: crawl | resume | report | analysis | partial | monitor | reset-title | clean');
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// silence unused import in some builds
void fileURLToPath;
