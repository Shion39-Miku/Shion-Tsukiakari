import {readConfig,check}from'./core.mjs';
import {createApplication}from'./app.mjs';
try{const config=readConfig();check(config.websiteUrl,'独立聊天服务需要配置 WEBSITE_BASE_URL。');const server=await createApplication({...config,serviceMode:'chat',seedDemo:false});server.listen(config.port,config.host,()=>console.log('月明かり聊天后端已启动。'));process.once('SIGINT',()=>server.close());process.once('SIGTERM',()=>server.close());}catch(error){console.error(error.message);process.exitCode=1;}
