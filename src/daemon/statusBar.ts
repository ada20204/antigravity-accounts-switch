import * as vscode from 'vscode';
import { accountService } from './accounts';
import { log } from './logger';
import type { RouteState } from './routes';
import { executeAccountSwitch, parseQuotaOverview, simplifyTier } from './switchService';

export interface StatusBarManager {
  updateStatusBar(): void;
  dispose(): void;
}

export function createStatusBarManager(
  context: vscode.ExtensionContext,
  state: RouteState,
  openLoginTerminal: () => Promise<void>,
): StatusBarManager {
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'antigravityAccountsSwitch.switchAccount';
  context.subscriptions.push(statusBarItem);

  function updateStatusBar(): void {
    try {
      const overview: any = accountService.overview('antigravity-cli');
      const accounts: any[] = overview.accounts ?? [];
      const active = accounts.find(a => a.is_active);

      if (!active) {
        statusBarItem.text = '$(shield) Antigravity: 未登录';
        statusBarItem.tooltip = '未检测到活跃的 Antigravity 账号，点击选择或添加账号';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        statusBarItem.show();
        return;
      }

      const plan = simplifyTier(state.knownPlans[active.account_id] ?? active.quota?.user_tier?.name ?? 'Free');
      const quotaInfo = parseQuotaOverview(active.quota);
      const shortEmail = active.account_id.split('@')[0];

      statusBarItem.text = `$(shield) ${shortEmail} (${quotaInfo.minPercent}%)`;
      
      const tooltip = new vscode.MarkdownString();
      tooltip.isTrusted = true;
      tooltip.appendMarkdown(`### Antigravity 账号状态\n\n`);
      tooltip.appendMarkdown(`- **账号**: \`${active.account_id}\`\n`);
      tooltip.appendMarkdown(`- **等级**: **${plan}**\n`);
      tooltip.appendMarkdown(`- **Gemini 配额**: Weekly ${quotaInfo.geminiWeekly ?? '—'}% · 5h ${quotaInfo.gemini5h ?? '—'}%\n`);
      if (quotaInfo.threePWeekly != null) {
        tooltip.appendMarkdown(`- **Claude/GPT 配额**: Weekly ${quotaInfo.threePWeekly}% · 5h ${quotaInfo.threeP5h ?? '—'}%\n`);
      }
      if (active.quota?.issue) {
        tooltip.appendMarkdown(`\n> ⚠️ **异常状态**: ${active.quota.issue}\n`);
      }
      tooltip.appendMarkdown(`\n---\n*点击快速切换账号或管理*`);
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

  // QuickPick item interface
  interface AccountQuickPickItem extends vscode.QuickPickItem {
    accountId?: string;
    action?: 'add' | 'refresh';
  }

  const switchAccountCommand = vscode.commands.registerCommand(
    'antigravityAccountsSwitch.switchAccount',
    async () => {
      try {
        const overview: any = accountService.overview('antigravity-cli');
        const accounts: any[] = overview.accounts ?? [];

        const items: AccountQuickPickItem[] = [];

        for (const acc of accounts) {
          const plan = simplifyTier(state.knownPlans[acc.account_id] ?? acc.quota?.user_tier?.name ?? 'Free');
          const quota = parseQuotaOverview(acc.quota);
          const icon = acc.is_active ? '$(check)' : '$(account)';
          const activeTag = acc.is_active ? '【当前使用中】 ' : '';
          const gemDesc = `Gemini: W ${quota.geminiWeekly ?? '—'}% · 5h ${quota.gemini5h ?? '—'}%`;
          const threePDesc = quota.threePWeekly != null ? ` · 3P: W ${quota.threePWeekly}% · 5h ${quota.threeP5h ?? '—'}%` : '';

          items.push({
            label: `${icon} ${acc.account_id}`,
            description: `${plan} · 剩余 ${quota.minPercent}%`,
            detail: `${activeTag}${gemDesc}${threePDesc}${acc.quota?.issue ? ' · ' + acc.quota.issue : ''}`,
            accountId: acc.account_id,
          });
        }

        // Actions
        items.push({
          label: '',
          kind: vscode.QuickPickItemKind.Separator,
        });
        items.push({
          label: '$(add) 添加新 Google 账号...',
          detail: '打开交互终端执行 Google OAuth 登录流程',
          action: 'add',
        });
        items.push({
          label: '$(sync) 刷新全部账号配额',
          detail: '从缓存中重新读取并刷新所有已保存账号的配额状态',
          action: 'refresh',
        });

        const selected = await vscode.window.showQuickPick(items, {
          placeHolder: '选择要切换的 Antigravity 账号，或执行管理操作',
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!selected) return;

        if (selected.action === 'add') {
          await openLoginTerminal();
          return;
        }

        if (selected.action === 'refresh') {
          accountService.quotaBatchSnapshot();
          updateStatusBar();
          vscode.window.showInformationMessage('已刷新所有账号配额快照');
          return;
        }

        if (selected.accountId) {
          const targetId = selected.accountId;
          const currentActive = accounts.find(a => a.is_active)?.account_id;
          if (targetId === currentActive) {
            vscode.window.showInformationMessage(`账号 ${targetId} 目前已在使用中`);
            return;
          }

          const confirmed = await vscode.window.showInformationMessage(
            `切换账号会重启 Antigravity 会话并刷新窗口。确定切换至 ${targetId} 吗？`,
            { modal: true },
            '确认切换'
          );
          if (confirmed !== '确认切换') return;

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `正在切换 Antigravity 账号至 ${targetId}...`,
              cancellable: false,
            },
            async () => {
              const res = await executeAccountSwitch(targetId, { source: 'statusBar' });
              if (res.success) {
                updateStatusBar();
                vscode.window.showInformationMessage(`成功切换至账号: ${targetId}`);
              } else {
                vscode.window.showErrorMessage(`切换账号失败: ${res.error}`);
              }
            }
          );
        }
      } catch (e: any) {
        vscode.window.showErrorMessage(`切换账号失败: ${e?.message ?? String(e)}`);
      }
    }
  );

  const refreshQuotaCommand = vscode.commands.registerCommand(
    'antigravityAccountsSwitch.refreshQuota',
    () => {
      accountService.quotaBatchSnapshot();
      updateStatusBar();
      vscode.window.showInformationMessage('Antigravity 账号配额已刷新');
    }
  );

  context.subscriptions.push(switchAccountCommand, refreshQuotaCommand);

  // Initial update
  updateStatusBar();

  // Background polling every 30s to keep status bar quota & plan fresh
  const timer = setInterval(updateStatusBar, 30_000);

  return {
    updateStatusBar,
    dispose: () => {
      clearInterval(timer);
      statusBarItem.dispose();
    },
  };
}
