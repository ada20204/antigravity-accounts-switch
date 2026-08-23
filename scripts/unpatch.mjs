import fs from 'fs';
import path from 'path';
import os from 'os';

const TARGET_BRIDGE = path.join(os.homedir(), '.vscode/extensions/google.google-antigravity-1.0.0/bridge.js');
const BACKUP_BRIDGE = TARGET_BRIDGE + '.bak';

const HOOK_FLAG_START = '// === ANTIGRAVITY_ENHANCER_LOADER_START ===';
const HOOK_FLAG_END = '// === ANTIGRAVITY_ENHANCER_LOADER_END ===';

if (!fs.existsSync(TARGET_BRIDGE)) {
  console.error('Target bridge.js not found at:', TARGET_BRIDGE);
  process.exit(1);
}

if (fs.existsSync(BACKUP_BRIDGE)) {
  fs.copyFileSync(BACKUP_BRIDGE, TARGET_BRIDGE);
  fs.unlinkSync(BACKUP_BRIDGE);
  console.log('Restored bridge.js from backup and deleted backup file.');
} else {
  let content = fs.readFileSync(TARGET_BRIDGE, 'utf-8');
  if (content.includes(HOOK_FLAG_START)) {
    const regex = new RegExp(`${HOOK_FLAG_START}[\\s\\S]*?${HOOK_FLAG_END}`, 'g');
    content = content.replace(regex, '');
    fs.writeFileSync(TARGET_BRIDGE, content, 'utf-8');
    console.log('Removed patch hook from bridge.js');
  } else {
    console.log('No patch hook found in bridge.js');
  }
}
