import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createGameServer } from './src/server.mjs';
import { loadConfig } from './src/config.mjs';

function startupError(error) {
  console.error(`服务启动失败：${error.message}`);
  if (error.code === 'EADDRINUSE') console.error('端口已被占用，请关闭之前的游戏窗口，或在 .env 中修改 PORT。');
  process.exitCode = 1;
}

try {
  const { port, host, dataDirectory, accessDirectory, cookieSecure } = loadConfig();
  const dataFile = join(dataDirectory, 'rooms.json');
  const server = createGameServer({ dataFile, accessDirectory, cookieSecure,
    runtimeId: process.env.XIANGWA_RUNTIME_ID || undefined });
  server.on('error', startupError);
  server.listen(port, host, () => {
    const actualPort = server.address().port;
    const localHost = ['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost'].includes(host) ? 'localhost'
      : host.includes(':') ? `[${host}]` : host;
    console.log(`《箱娃》四／五人联机版：http://${localHost}:${actualPort}`);
    console.log(`自动存档：${dataFile}`);
    console.log('发放邀请码：双击“发放邀请码.cmd”，或另开终端运行 npm run invite。');
    console.log('远程联机：另开终端运行 npm run share；按 Ctrl+C 停止本窗口的服务。');
    if (['0.0.0.0', '::'].includes(host)) for (const network of Object.values(networkInterfaces()).flat()) {
      if (network.family === 'IPv4' && !network.internal) console.log(`局域网地址：http://${network.address}:${actualPort}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
} catch (error) { startupError(error); }
