import { statSync } from 'node:fs';
import { readConfig, check } from './core.mjs';
import { createApplication } from './app.mjs';

try {
  const config = readConfig();
  check(config.websiteUrl, '独立聊天服务需要配置 WEBSITE_BASE_URL。');
  check(config.serviceMode !== 'website', '聊天入口需要独立的聊天服务配置。');
  const production = process.env.NODE_ENV === 'production';
  if (production) {
    check(process.env.DATABASE_PATH && statSync(config.dbPath, { throwIfNoEntry: false })?.isFile(),
      '生产聊天库尚未就绪。请先验证并导入现有账号和聊天数据。');
    check(config.secureCookie && config.baseUrl.startsWith('https://') && ['127.0.0.1', '::1'].includes(config.host),
      '生产聊天服务须使用回环监听、公开 HTTPS 地址和安全会话 Cookie。');
  }
  const server = await createApplication({ ...config, serviceMode: 'chat', seedDemo: false, reportChatPrune: production });
  server.listen(config.port, config.host, () => console.log('月明かり聊天后端已启动。'));
  const stop = () => {
    server.close();
    const timeout = setTimeout(() => server.closeAllConnections(), 5_000);
    timeout.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
