import * as vscode from 'vscode';
import { accountService, keychain } from './accounts';
import { log } from './logger';
import type { RouteState } from './routes';
import { maskEmail, parseQuotaOverview, simplifyTier } from './switchService';

export interface StatusBarManager {
  updateStatusBar(): void;
  dispose(): void;
}

function getExtensionConfig() {
  const cfg = vscode.workspace.getConfiguration('antigravityAccountsSwitch');
  const mask = cfg.get<boolean>('maskEmails', true);
  const lang = cfg.get<string>('language', 'auto');
  const isZh = lang === 'zh' || (lang === 'auto' && vscode.env.language.toLowerCase().startsWith('zh'));
  return { mask, lang, isZh };
}

export function createStatusBarManager(
  context: vscode.ExtensionContext,
  state: RouteState,
): StatusBarManager {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  context.subscriptions.push(statusBarItem);

  function updateStatusBar(): void {
    try {
      try {
        keychain.syncActiveTokens();
      } catch {}

      const { mask, isZh } = getExtensionConfig();
      const overview: any = accountService.overview('antigravity-cli');
      const accounts: any[] = overview.accounts ?? [];
      const active = accounts.find(a => a.is_active);

      if (!active) {
        statusBarItem.text = isZh ? '$(shield) Antigravity: 未登录' : '$(shield) Antigravity: Signed Out';
        statusBarItem.tooltip = isZh
          ? '未检测到活跃的 Antigravity 账号'
          : 'No active Antigravity account found.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.show();
        return;
      }

      const plan = simplifyTier(state.knownPlans[active.account_id] ?? active.quota?.user_tier?.name ?? 'Free');
      const quotaInfo = parseQuotaOverview(active.quota);
      const rawUser = active.account_id.split('@')[0];
      const shortUser = mask ? maskEmail(rawUser, true) : rawUser;
      const displayId = mask ? maskEmail(active.account_id, true) : active.account_id;

      statusBarItem.text = `$(shield) ${shortUser} (${quotaInfo.minPercent}%)`;
      
      const tooltip = new vscode.MarkdownString();
      tooltip.isTrusted = true;
      if (isZh) {
        tooltip.appendMarkdown(`### Antigravity 账号状态\n\n`);
        tooltip.appendMarkdown(`- **账号**: \`${displayId}\`\n`);
        tooltip.appendMarkdown(`- **方案**: **${plan}**\n`);
        tooltip.appendMarkdown(`- **Gemini 配额**: 周 ${quotaInfo.geminiWeekly ?? '—'}% · 5h ${quotaInfo.gemini5h ?? '—'}%\n`);
        if (quotaInfo.threePWeekly != null) {
          tooltip.appendMarkdown(`- **Claude/GPT 配额**: 周 ${quotaInfo.threePWeekly}% · 5h ${quotaInfo.threeP5h ?? '—'}%\n`);
        }
        if (active.quota?.issue) {
          tooltip.appendMarkdown(`\n> ⚠️ **异常状态**: ${active.quota.issue}\n`);
        }
      } else {
        tooltip.appendMarkdown(`### Antigravity Account Status\n\n`);
        tooltip.appendMarkdown(`- **Account**: \`${displayId}\`\n`);
        tooltip.appendMarkdown(`- **Tier**: **${plan}**\n`);
        tooltip.appendMarkdown(`- **Gemini Quota**: Weekly ${quotaInfo.geminiWeekly ?? '—'}% · 5h ${quotaInfo.gemini5h ?? '—'}%\n`);
        if (quotaInfo.threePWeekly != null) {
          tooltip.appendMarkdown(`- **Claude/GPT Quota**: Weekly ${quotaInfo.threePWeekly}% · 5h ${quotaInfo.threeP5h ?? '—'}%\n`);
        }
        if (active.quota?.issue) {
          tooltip.appendMarkdown(`\n> ⚠️ **Issue**: ${active.quota.issue}\n`);
        }
      }
      statusBarItem.tooltip = tooltip;

      if (active.quota?.issue) {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      } else if (quotaInfo.minPercent < 20) {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      } else {
        statusBarItem.backgroundColor = undefined;
      }

      statusBarItem.show();
    } catch (err: any) {
      log('STATUS_BAR', 'failed to update status bar', err?.message ?? String(err));
    }
  }

  const refreshQuotaCommand = vscode.commands.registerCommand(
    'antigravityAccountsSwitch.refreshQuota',
    () => {
      accountService.quotaBatchSnapshot();
      updateStatusBar();
      const { isZh } = getExtensionConfig();
      vscode.window.showInformationMessage(isZh ? 'Antigravity 账号配额已刷新' : 'Antigravity account quota refreshed');
    }
  );

  context.subscriptions.push(
    refreshQuotaCommand,
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('antigravityAccountsSwitch')) {
        updateStatusBar();
      }
    })
  );

  // Initial update
  updateStatusBar();

  // Background polling every 30s to keep status bar quota & plan fresh and sync tokens
  const timer = setInterval(updateStatusBar, 30_000);

  return {
    updateStatusBar,
    dispose: () => {
      clearInterval(timer);
      statusBarItem.dispose();
    },
  };
}
