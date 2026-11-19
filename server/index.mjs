import { readConfig } from './core.mjs';
import { createApplication } from './app.mjs';

try {
  const config = readConfig();
  const server = await createApplication(config);
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请设置 PORT。` : error.message);
    server.close();
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    const host = config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host;
    console.log(`${config.site.name}正在监听 http://${host}:${config.port}`);
    console.log(`管理后台 http://${host}:${config.port}/admin`);
  });
  process.on('SIGINT', () => server.close());
  process.on('SIGTERM', () => server.close());
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
