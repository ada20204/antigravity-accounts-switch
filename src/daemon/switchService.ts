// Unified account switching transaction service & quota parsing domain helpers.
// Consolidates locking, credential update, hub restart, and timing logging into a single transactional use-case.

import { accountService, withFileLock, paths as accountPaths } from './accounts';
import { restartAntigravityHub } from './hubRestart';
import { log } from './logger';

export interface SwitchTransactionOptions {
  source?: string;
  onSwitched?: (output: any) => void;
}

export interface SwitchAccountResult {
  success: boolean;
  accountId: string;
  output?: any;
  hubRestart?: any;
  error?: string;
}

export async function executeAccountSwitch(
  accountId: string,
  options?: SwitchTransactionOptions
): Promise<SwitchAccountResult> {
  const source = options?.source ?? 'api';
  log('SWITCH', `requested (source: ${source})`, accountId);

  const tSwitchStart = Date.now();
  let output: any;
  try {
    output = withFileLock(accountPaths.switchLockPath, () => accountService.switchAccount(accountId));
    log('SWITCH', `succeeded (source: ${source})`, accountId);
  } catch (err: any) {
    log('SWITCH', `switch to ${accountId} failed`, err?.message ?? String(err));
    return { success: false, accountId, error: err?.message ?? String(err) };
  }

  // Allow caller to hook right after Keychain update (e.g. commit HTTP response before hub reload races)
  options?.onSwitched?.(output);

  try {
    const switchMs = Date.now() - tSwitchStart;
    const hubRestart = await restartAntigravityHub();
    log('SWITCH', 'hub restart result:', hubRestart.detail);
    log('TIMING', 'switch', accountId, {
      strategy: hubRestart.strategy,
      switchMs,
      hubStopMs: hubRestart.timingMs.stopHub,
      hubHealthyMs: hubRestart.timingMs.hubHealthy,
      reloadMs: hubRestart.timingMs.reload,
    });
    return { success: true, accountId, output, hubRestart };
  } catch (e: any) {
    log('HUB_RESTART', 'hub restart failed after switch', e?.message ?? String(e));
    return { success: false, accountId, output, error: e?.message ?? String(e) };
  }
}

export interface ParsedQuotaInfo {
  geminiWeekly: number | null;
  gemini5h: number | null;
  threePWeekly: number | null;
  threeP5h: number | null;
  minPercent: number;
}

export function findQuotaFraction(groups: any[] | undefined, bucketId: string): number | null {
  for (const group of groups ?? []) {
    const bucket = group.buckets?.find((b: any) => b.id === bucketId);
    if (bucket?.remaining_fraction != null) return bucket.remaining_fraction;
  }
  return null;
}

export function parseQuotaOverview(quota: any): ParsedQuotaInfo {
  const gemWeeklyFraction = findQuotaFraction(quota?.groups, 'gemini-weekly');
  const gem5hFraction = findQuotaFraction(quota?.groups, 'gemini-5h');
  const threePWeeklyFraction = findQuotaFraction(quota?.groups, '3p-weekly');
  const threeP5hFraction = findQuotaFraction(quota?.groups, '3p-5h');

  const geminiWeekly = gemWeeklyFraction != null ? Math.round(gemWeeklyFraction * 100) : null;
  const gemini5h = gem5hFraction != null ? Math.round(gem5hFraction * 100) : null;
  const threePWeekly = threePWeeklyFraction != null ? Math.round(threePWeeklyFraction * 100) : null;
  const threeP5h = threeP5hFraction != null ? Math.round(threeP5hFraction * 100) : null;

  const validPercentages = [geminiWeekly, gemini5h, threePWeekly, threeP5h].filter((v): v is number => v !== null);
  const minPercent = validPercentages.length > 0 ? Math.min(...validPercentages) : (quota?.issue ? 0 : 100);

  return { geminiWeekly, gemini5h, threePWeekly, threeP5h, minPercent };
}

export type AccountTier = 'Ultra' | 'Pro' | 'Free';

/**
 * Simplifies verbose Antigravity tier descriptions into standard clean badges: Free, Pro, Ultra.
 * Enforces a strict whitelist to avoid unexpected plan string leakage.
 */
export function simplifyTier(tier?: string | null): AccountTier {
  if (!tier || tier === 'Unknown') return 'Free';
  const t = tier.trim();
  if (/ultra/i.test(t)) return 'Ultra';
  if (/pro/i.test(t)) return 'Pro';
  return 'Free';
}

