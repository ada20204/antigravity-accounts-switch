import fs from 'fs';
import path from 'path';
import os from 'os';

const TARGET_BRIDGE = path.join(os.homedir(), '.vscode/extensions/google.google-antigravity-1.0.0/bridge.js');
const BACKUP_BRIDGE = TARGET_BRIDGE + '.bak';

const HOOK_FLAG_START = '// === ANTIGRAVITY_ENHANCER_LOADER_START ===';
const HOOK_FLAG_END = '// === ANTIGRAVITY_ENHANCER_LOADER_END ===';

const LOADER_CODE = `
${HOOK_FLAG_START}
(function() {
  if (typeof window === 'undefined') return;
  const DEV_SERVER_URL = 'http://localhost:5173/src/runtime/main.ts';
  const FALLBACK_BUNDLE = 'http://localhost:5173/dist/runtime.js';
  
  const script = document.createElement('script');
  script.type = 'module';
  script.src = DEV_SERVER_URL;
  script.onerror = () => {
    console.warn('[Enhancer] Dev server offline, attempting static bundle...');
    const s2 = document.createElement('script');
    s2.src = FALLBACK_BUNDLE;
    document.head.appendChild(s2);
  };
  document.head.appendChild(script);
})();
${HOOK_FLAG_END}
`;

if (!fs.existsSync(TARGET_BRIDGE)) {
  console.error('Target bridge.js not found at:', TARGET_BRIDGE);
  process.exit(1);
}

if (!fs.existsSync(BACKUP_BRIDGE)) {
  fs.copyFileSync(TARGET_BRIDGE, BACKUP_BRIDGE);
  console.log('Created backup at:', BACKUP_BRIDGE);
}

let content = fs.readFileSync(TARGET_BRIDGE, 'utf-8');

if (content.includes(HOOK_FLAG_START)) {
  const regex = new RegExp(`${HOOK_FLAG_START}[\\s\\S]*?${HOOK_FLAG_END}`, 'g');
  content = content.replace(regex, '');
}

content = content.trimEnd() + '\n' + LOADER_CODE + '\n';
fs.writeFileSync(TARGET_BRIDGE, content, 'utf-8');
console.log('Successfully patched Antigravity bridge.js with live Hot-Reload loader!');
