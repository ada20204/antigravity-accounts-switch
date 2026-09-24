// Runtime i18n & email desensitization state management.

export type Lang = 'zh' | 'en';

const LANG_STORAGE_KEY = 'ag_ui_lang';
const MASK_STORAGE_KEY = 'ag_mask_emails';

export function getLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {}
  const nav = (typeof navigator !== 'undefined' ? navigator.language : '').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {}
  window.dispatchEvent(new CustomEvent('ag-lang-changed', { detail: { lang } }));
}

export function getMaskEmails(): boolean {
  try {
    const saved = localStorage.getItem(MASK_STORAGE_KEY);
    if (saved === 'true') return true;
    if (saved === 'false') return false;
  } catch {}
  return true; // Default to desensitized/masked for privacy
}

export function setMaskEmails(masked: boolean): void {
  try {
    localStorage.setItem(MASK_STORAGE_KEY, masked ? 'true' : 'false');
  } catch {}
  window.dispatchEvent(new CustomEvent('ag-mask-changed', { detail: { masked } }));
}

/**
 * Desensitizes an email address or username for privacy display.
 * Retains first 3 chars and last 2 chars (or 1/1 for short usernames),
 * replacing the center with '***'.
 */
export function maskEmail(str: string | null | undefined, masked: boolean = true): string {
  if (!masked || !str) return str ?? '';
  const atIndex = str.indexOf('@');
  if (atIndex > 0) {
    const user = str.slice(0, atIndex);
    const domain = str.slice(atIndex);
    return `${maskUsername(user)}${domain}`;
  }
  return maskUsername(str);
}

function maskUsername(user: string): string {
  if (user.length <= 2) {
    return `${user[0]}***`;
  }
  if (user.length <= 5) {
    return `${user[0]}***${user.slice(-1)}`;
  }
  return `${user.slice(0, 3)}***${user.slice(-2)}`;
}

const DICT = {
  zh: {
    cardTitleFull: '多账号配额看板',
    cardTitleCompact: '账号配额',
    noAccounts: '未连接任何账号',
    avgQuota: (avg: number, count: number) => `${count} 个账号平均 ${avg}%`,
    avgQuotaCompact: (avg: number) => `均值 ${avg}%`,
    resetSort: '重置',
    resetSortTitle: '重置所有排序规则，恢复默认账号顺序',
    checkAll: '全量巡检',
    checkAllTitle: '依次快速切换所有已连接账号以检查其实际配额',
    export: '导出',
    exportTitle: '将已保存的账号凭证导出为备份文件',
    import: '导入',
    importTitle: '从备份文件中导入账号凭证',
    maskBtnMasked: '明文',
    maskBtnMaskedTitle: '当前已脱敏隐藏，点击展示完整邮箱',
    maskBtnPlain: '脱敏',
    maskBtnPlainTitle: '当前为明文展示，点击脱敏隐藏邮箱',
    langBtn: 'EN',
    langBtnTitle: 'Switch interface language to English',
    emptyTip: '尚未连接任何账号。可打开左下角账号头像菜单选择“添加新账号”以绑定。',
    adoptLogin: (email: string) => `使用当前登录账号 (${email})`,
    colAccountTier: '账号 / 方案',
    colGemini: 'Gemini',
    colClaude: 'Claude & GPT',
    colStatus: '状态',
    sortTierTip: '按账号方案排序 (Ultra → Pro → Free)。连续点击叠加优先级并切换升降序。',
    sortGeminiTip: '按 Gemini 5h 配额排序。连续点击叠加优先级并切换升降序。',
    sortClaudeTip: '按 Claude & GPT 5h 配额排序。连续点击叠加优先级并切换升降序。',
    statusActive: '当前',
    statusSwitch: '切换',
    activeTitle: '当前使用中的账号',
    switchTitle: '点击切换至此账号',
    removeBtnTitle: (name: string) => `移除账号 ${name}`,
    issueRemaining: '0% 剩余',
    checkingAccounts: '正在巡检账号...',
    saving: '正在保存…',
    noAccountsToExport: '尚未连接任何账号，无内容可导出。',
    exportSuccess: (accounts: number, creds: number) => `已导出 ${accounts} 个账号 (${creds} 个包含完整凭证)。`,
    importSuccess: (imported: number, overwritten: number) => `成功导入 ${imported} 个新账号，覆盖 ${overwritten} 个已有账号。`,
    confirmAdopt: (email: string) => `将 ${email} 保存为已连接账号？\n\n这不会注销当前账号或改变 Antigravity 的任何配置，仅记录此登录凭证以便后续切换。`,
    confirmRefreshAll: '全量巡检会依次快速切换当前 Antigravity 登录至每个已连接账号，以获取真实配额数据（会中断进行中的请求），随后切回当前账号。是否继续？',
    confirmExport: (count: number) => `导出 ${count} 个账号的凭证到文件？\n\n该文件将包含未加密的 Google 登录凭证，请妥善保管。拥有此文件的任何人均可登录这些账号。`,
    confirmImport: '从文件导入账号？\n\n文件中与现有账号 ID 相同的账号将被覆盖。此操作无法撤销。是否继续？',
    confirmRemove: (id: string) => `确定移除账号 ${id} 吗？\n\n这会删除该账号在此设备上保存的本地凭证，后续无法直接切换回该账号（如需重新添加需重新进行 Google 登录授权）。这不会注销该 Google 账号在其他地方的登录状态。`,
    popupBestQuota: '最佳可用额度',
    popupConnectedAccounts: (count: number) => `${count} 个已连接账号`,
    popupAddAccount: '添加新账号',
    ok: '确定',
    cancel: '取消',
    confirmSwitchTitle: '切换账号确认',
    confirmSwitchMessage: (email: string) => `即将切换至账号：\n${email}\n\n切换账号将重新连接 Antigravity 并中断进行中的生成任务。是否确认切换？`,
    confirmSwitchOk: '确认切换',
    switchingTo: (email: string) => `正在切换到 ${email}…`,
    switchingDetail: 'Antigravity 正在应用新账号凭据并重新连接，请稍候几秒…',
    switchFailed: '切换账号失败，当前仍保持原有账号登录状态。详情请查看 daemon 日志。',
    switchFailedTitle: '切换失败',
    switchFailedOk: '我知道了',
    confirmSignOutAdd: '此操作将注销当前 Antigravity 登录，以便使用其他 Google 账号登录。\n\n当前账号已提前保存，可随时切回。是否继续？',
    progressSignOutAddTitle: '正在注销以添加新账号…',
    progressSignOutAddDetail: 'Antigravity 即将重载并显示登录页面。',
    couldNotStartSignIn: (error?: string) => `无法开始登录：${error ?? '未知错误'}\n\n未做任何更改。`,
  },
  en: {
    cardTitleFull: 'Connected Subscriptions',
    cardTitleCompact: 'Accounts Quota',
    noAccounts: 'No accounts connected',
    avgQuota: (avg: number, count: number) => `${count} accounts · avg ${avg}%`,
    avgQuotaCompact: (avg: number) => `${avg}% avg`,
    resetSort: 'Reset',
    resetSortTitle: 'Reset all sorting and return to default account order',
    checkAll: 'Check All Accounts',
    checkAllTitle: 'Switches through every connected account to check its quota',
    export: 'Export',
    exportTitle: 'Save all connected accounts, including their credentials, to a file you choose',
    import: 'Import',
    importTitle: 'Load accounts from a previously exported file',
    maskBtnMasked: 'Reveal',
    maskBtnMaskedTitle: 'Emails are currently masked. Click to show full email addresses',
    maskBtnPlain: 'Mask',
    maskBtnPlainTitle: 'Emails are currently revealed. Click to mask email addresses',
    langBtn: '中',
    langBtnTitle: '切换界面语言为简体中文',
    emptyTip: 'No accounts connected yet. Open the account menu in the bottom-left corner and choose “Add new account” to connect one.',
    adoptLogin: (email: string) => `Use current login (${email})`,
    colAccountTier: 'Account / Tier',
    colGemini: 'Gemini',
    colClaude: 'Claude & GPT',
    colStatus: 'Status',
    sortTierTip: 'Sort by Account Tier (Ultra → Pro → Free). Consecutive clicks prioritize and toggle direction.',
    sortGeminiTip: 'Sort by Gemini 5h Quota. Consecutive clicks prioritize and toggle direction.',
    sortClaudeTip: 'Sort by Claude & GPT 5h Quota. Consecutive clicks prioritize and toggle direction.',
    statusActive: 'Active',
    statusSwitch: 'Switch',
    activeTitle: 'Current active account',
    switchTitle: 'Click to switch to this account',
    removeBtnTitle: (name: string) => `Remove ${name}`,
    issueRemaining: '0% Remaining',
    checkingAccounts: 'Checking accounts...',
    saving: 'Saving…',
    noAccountsToExport: 'No accounts connected yet — nothing to export.',
    exportSuccess: (accounts: number, creds: number) => `Exported ${accounts} account${accounts === 1 ? '' : 's'} (${creds} with credentials).`,
    importSuccess: (imported: number, overwritten: number) => `Imported ${imported} new account${imported === 1 ? '' : 's'}, overwrote ${overwritten}.`,
    confirmAdopt: (email: string) => `Save ${email} as a connected account?\n\nThis does not sign you out or change anything in Antigravity — it just remembers this login so you can switch back to it later.`,
    confirmRefreshAll: "Checking all accounts' quota will briefly switch your active Antigravity login through each connected account in turn (interrupting any in-progress response), then switch back. This is NOT the same as the lightweight refresh button on the official page. Continue?",
    confirmExport: (count: number) => `Export ${count} account${count === 1 ? '' : 's'} to a file?\n\nThe file will contain your saved Google account credentials in a portable, NOT encrypted form. Keep it somewhere private — anyone with this file can sign in as these accounts.`,
    confirmImport: 'Import accounts from a file?\n\nAny account in the file that matches an ID you already have will be OVERWRITTEN with the file\'s credentials. This cannot be undone. Continue?',
    confirmRemove: (id: string) => `Remove ${id}?\n\nThis deletes the saved credential for this account, so you can no longer switch to it — adding it back requires signing in with Google again. It does NOT sign the account out of Google or affect it anywhere else.`,
    popupBestQuota: 'Best account remaining',
    popupConnectedAccounts: (count: number) => `${count} connected account${count === 1 ? '' : 's'}`,
    popupAddAccount: 'Add new account',
    ok: 'OK',
    cancel: 'Cancel',
    confirmSwitchTitle: 'Switch Account Confirmation',
    confirmSwitchMessage: (email: string) => `About to switch to account:\n${email}\n\nSwitching accounts will reconnect Antigravity and interrupt any in-progress generation tasks. Are you sure you want to switch?`,
    confirmSwitchOk: 'Switch Account',
    switchingTo: (email: string) => `Switching to ${email}…`,
    switchingDetail: 'Antigravity is applying new credentials and reconnecting, please wait…',
    switchFailed: 'Failed to switch account. You remain signed in to the previous account. Check daemon logs for details.',
    switchFailedTitle: 'Switch Failed',
    switchFailedOk: 'Got it',
    confirmSignOutAdd: 'This signs you out of Antigravity here so you can log in with a different Google account.\n\nYour current account is saved first and can be restored at any time. Continue?',
    progressSignOutAddTitle: 'Signing out so you can add an account…',
    progressSignOutAddDetail: 'Antigravity will reload and show its sign-in screen.',
    couldNotStartSignIn: (error?: string) => `Could not start sign-in: ${error ?? 'unknown error'}\n\nNothing was changed.`,
  },
};

export function t(): typeof DICT['zh'] {
  return DICT[getLang()];
}
