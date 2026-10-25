import http from 'node:http';
import type { Logger } from 'pino';
import type { CrawlController } from '../pipeline/crawler.js';

export interface ControlHandle {
  close(): Promise<void>;
  url: string;
}

export function startControlServer(
  port: number,
  logger: Logger,
  getController: () => CrawlController | null,
): Promise<ControlHandle> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const ctrl = getController();
    const send = (code: number, body: unknown) => {
      const json = JSON.stringify(body);
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(json);
    };
    if (url.pathname === '/status') {
      send(200, ctrl?.status() ?? { phase: 'idle' });
      return;
    }
    if (url.pathname === '/pause' && req.method === 'POST') {
      ctrl?.pause();
      send(200, { ok: true, action: 'pause' });
      return;
    }
    if (url.pathname === '/resume' && req.method === 'POST') {
      ctrl?.resume();
      send(200, { ok: true, action: 'resume' });
      return;
    }
    if (url.pathname === '/abort' && req.method === 'POST') {
      ctrl?.abort('control_api');
      send(200, { ok: true, action: 'abort' });
      return;
    }
    send(404, { error: 'not_found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      logger.info({ port, msg: 'control_server_listening' });
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}
