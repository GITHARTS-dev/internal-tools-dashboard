/**
 * What a tool costs on a given day.
 *
 * The one rule: a bill is priced at the latest change that started on or
 * before its due date. Before the first recorded change, the price is what it
 * was then (the change's `previous_amount`); with no changes at all, it is the
 * tool's cost. Pure, so the API, the daily job and the tool page agree.
 */

import type { IsoDate, PriceChange, Tool } from './types';

export interface Price {
  amount: number;
  currency: string;
}

/** Oldest first, which is the order `priceOn` reads them in. */
export function sortChanges(changes: PriceChange[]): PriceChange[] {
  return [...changes].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
}

export function priceOn(tool: Tool, changes: PriceChange[], date: IsoDate): Price | null {
  const ordered = sortChanges(changes.filter((c) => c.tool_id === tool.id));
  let current: PriceChange | null = null;
  for (const change of ordered) {
    if (change.effective_from <= date) current = change;
  }
  if (current) return { amount: current.amount, currency: current.currency };

  const first = ordered[0];
  if (first && first.previous_amount !== null) {
    return { amount: first.previous_amount, currency: first.previous_currency ?? first.currency };
  }
  return tool.cost_amount === null ? null : { amount: tool.cost_amount, currency: tool.currency };
}

/** Group changes by tool, so a loop over many tools does not filter each time. */
export function changesByTool(changes: PriceChange[]): Map<string, PriceChange[]> {
  const out = new Map<string, PriceChange[]>();
  for (const change of changes) {
    const list = out.get(change.tool_id);
    if (list) list.push(change);
    else out.set(change.tool_id, [change]);
  }
  return out;
}
