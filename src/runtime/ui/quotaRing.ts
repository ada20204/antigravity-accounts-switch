import { escapeHtml } from '../adapters/domUtils';

export function getQuotaColor(percent: number | null | undefined): string {
  if (percent == null) return '#6b7280';
  if (percent < 20) return '#ef4444';
  if (percent < 50) return '#f59e0b';
  return '#22c55e';
}

export interface ConcentricRingOptions {
  fiveHour: number | null | undefined;
  weekly: number | null | undefined;
  issue?: string | null;
  label: string;
  isZh?: boolean;
}

export function renderConcentricRing(options: ConcentricRingOptions): string {
  const { fiveHour, weekly, issue, label, isZh = false } = options;
  const hasIssue = Boolean(issue);
  const fiveHVal = hasIssue ? 0 : fiveHour;
  const weeklyVal = hasIssue ? 0 : weekly;

  const weeklyClamped = weeklyVal != null ? Math.max(0, Math.min(100, weeklyVal)) : null;
  const fiveHClamped = fiveHVal != null ? Math.max(0, Math.min(100, fiveHVal)) : null;

  // Outer ring (Weekly): R=16, stroke-width=3. C = 2 * PI * 16 ≈ 100.53
  const outerR = 16;
  const outerC = 2 * Math.PI * outerR;
  const outerOffset = weeklyClamped != null ? outerC * (1 - weeklyClamped / 100) : outerC;
  const outerColor = hasIssue ? '#ef4444' : getQuotaColor(weeklyClamped);

  // Inner ring (5h): R=11, stroke-width=3. C = 2 * PI * 11 ≈ 69.12
  const innerR = 11;
  const innerC = 2 * Math.PI * innerR;
  const innerOffset = fiveHClamped != null ? innerC * (1 - fiveHClamped / 100) : innerC;
  const innerColor = hasIssue ? '#ef4444' : getQuotaColor(fiveHClamped);

  const weeklyStr = weeklyVal != null ? `${weeklyVal}%` : (isZh ? '无' : 'None');
  const fiveHStr = fiveHVal != null ? `${fiveHVal}%` : (isZh ? '无' : 'None');
  const tooltip = isZh
    ? `${label}\n外环(周配额): ${weeklyStr}\n内环(5h配额): ${fiveHStr}`
    : `${label}\nOuter ring (Weekly): ${weeklyStr}\nInner ring (5h): ${fiveHStr}`;

  return `
    <svg class="ag-concentric-ring" viewBox="0 0 40 40" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">
      <!-- Outer Track (Weekly) -->
      <circle class="ag-ring-track" cx="20" cy="20" r="${outerR}"></circle>
      ${weeklyClamped != null ? `
      <circle class="ag-ring-value" cx="20" cy="20" r="${outerR}"
        style="stroke:${outerColor};stroke-dasharray:${outerC.toFixed(2)};stroke-dashoffset:${outerOffset.toFixed(2)};"></circle>
      ` : ''}

      <!-- Inner Track (5h) -->
      <circle class="ag-ring-track" cx="20" cy="20" r="${innerR}" style="${fiveHClamped == null ? 'opacity:0.2;' : ''}"></circle>
      ${fiveHClamped != null ? `
      <circle class="ag-ring-value" cx="20" cy="20" r="${innerR}"
        style="stroke:${innerColor};stroke-dasharray:${innerC.toFixed(2)};stroke-dashoffset:${innerOffset.toFixed(2)};"></circle>
      ` : ''}
    </svg>
  `;
}
