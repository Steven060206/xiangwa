import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createGameServer } from './src/server.mjs';

const port = Number(process.env.PORT ?? 4173);
const host = process.env.HOST ?? '0.0.0.0';
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须为 0 至 65535 的整数。');

const dataFile = resolve(process.env.DATA_DIR ?? 'data', 'rooms.json');
const server = createGameServer({ dataFile });
server.listen(port, host, () => {
  const actualPort = server.address().port;
  console.log(`《箱娃》四人地图准备：http://localhost:${actualPort}`);
  console.log(`自动存档：${dataFile}`);
  for (const network of Object.values(networkInterfaces()).flat()) {
    if (network.family === 'IPv4' && !network.internal) console.log(`局域网地址：http://${network.address}:${actualPort}`);
  }
});
server.on('error', error => {
  console.error(`服务启动失败：${error.message}`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
