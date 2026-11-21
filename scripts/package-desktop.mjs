import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareDesktop } from './prepare-desktop.mjs';
import { root, sha256 } from '../server/core.mjs';
const portableOnly = process.argv.includes('--portable-only');
const previous = portableOnly ? JSON.parse(await readFile(join(root, 'artifacts/desktop-app.json'), 'utf8')) : null;
const prepared = portableOnly ? { desktop: join(root, 'desktop'), output: join(root, 'desktop/.generated'), report: previous.preparation } : await prepareDesktop({ sharedChat: true });
const { desktop, output, report: preparation } = prepared;
const require = createRequire(join(desktop, 'package.json'));
const { build, Platform, Arch } = require('electron-builder');
const version = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8')).version;
const stamp = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 17);
const destination = previous?.directory || join(root, 'artifacts', 'Tsukiakari-'+version+'-' + stamp);
if (!portableOnly) {await mkdir(dirname(destination),{recursive:true});await mkdir(destination);} process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const paths = await build({ projectDir: desktop, ...(portableOnly ? { prepackaged: join(destination, 'win-unpacked') } : {}), targets: Platform.WINDOWS.createTarget(portableOnly ? ['portable'] : ['nsis', 'portable'], Arch.x64), publish: 'never', config: {
  appId: 'wiki.shion.hoshifuru', productName: 'Tsukiakari', electronVersion: require('electron/package.json').version,
  electronDist: dirname(require('electron')), directories: { output: destination, buildResources: desktop },
  copyright: 'Copyright © 2026 Shion', asar: true, npmRebuild: false, buildDependenciesFromSource: false,
  files: ['main.cjs', 'policy.cjs', 'features.cjs', 'window-prompts.cjs', '.generated/window-preload.cjs',
    'settings.html', 'settings.css', 'settings.js', 'splash.html', 'splash.css', 'icon.ico', 'icon.png', 'tray.png', 'package.json'],
  extraResources: [{ from: join(output, 'backend'), to: 'backend' }, {from:join(output,'seed/moonlit.sqlite'),to:'seed/moonlit.sqlite'},{from:join(output,'seed/website.sqlite'),to:'seed/website.sqlite'}, { from: join(output, 'initial-model.json'), to: 'initial-model.json' },{from:join(output,'initial-astrbot.json'),to:'initial-astrbot.json'}, {from:join(output,'chat-public.json'),to:'chat-public.json'}],
  // electron-builder deliberately filters nested node_modules in extraResources.
  // These are dependencies of the SEPARATE Node backend, not Electron modules.
  afterPack: async ({ appOutDir }) => {
    const backend = join(appOutDir, 'resources/backend');
    await cp(join(output, 'backend/node_modules'), join(backend, 'node_modules'), { recursive: true });
    const check = spawnSync(join(backend, 'runtime/node.exe'), ['--input-type=module', '-e',
      'import{createRequire}from"node:module";import{relative,isAbsolute}from"node:path";const base=process.argv[1],require=createRequire(base+"/package.json");for(const name of["busboy","sharp"]){const path=relative(base,require.resolve(name));if(path.startsWith("..")||isAbsolute(path))throw Error("Dependency escaped package: "+name);require(name)}', backend],
      { cwd: backend, encoding: 'utf8', windowsHide: true, env: { ...process.env, NODE_PATH: '' } });
    if (check.status !== 0) throw new Error('打包后的后端依赖检查失败：' + (check.stderr || check.error?.message));
  },
  win: { icon: join(desktop, 'icon.ico'), executableName: 'Tsukiakari', requestedExecutionLevel: 'asInvoker', target: ['nsis', 'portable'] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, createStartMenuShortcut: true, shortcutName: '月明かり',uninstallDisplayName:'月明かり (Tsukiakari)', runAfterFinish: false, deleteAppDataOnUninstall: false, artifactName: 'Tsukiakari-${version}-Setup.${ext}', installerLanguages: ['zh_CN', 'en_US'], language: '2052' },
  // In builder 26.18.0's NsisTarget implementation, true omits the fixed
  // UNPACK_DIR_NAME define, so portable.nsi uses a unique $PLUGINSDIR/app.
  // false unexpectedly creates one build-time KSUID shared across launches.
  portable: { artifactName: 'Tsukiakari-${version}-Portable.${ext}', requestExecutionLevel: 'user', unpackDirName: true },
  compression: 'normal', publish: null,
} });
const files = previous ? previous.files.filter((file) => !file.path.endsWith('Portable.exe')) : [];
for (const path of paths) if (/\.exe$/i.test(path)) files.push({ path, sha256: sha256(await readFile(path)) });
const release = { at: new Date().toISOString(), directory: destination, executable: join(destination, 'win-unpacked', 'Tsukiakari.exe'), files, version, electron: require('electron/package.json').version, node: process.version, preparation, cloudDeployed: false, signed: false };
await writeFile(join(root, 'artifacts/desktop-app.json'), JSON.stringify(release, null, 2));
await writeFile(join(destination, 'desktop-release.json'), JSON.stringify(release, null, 2));
console.log(JSON.stringify(release, null, 2));
