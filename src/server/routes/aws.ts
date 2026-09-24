import { Hono } from 'hono';
import type { Env } from '../context';
import { actor, db, envVars } from '../context';
import { addMonthsToYearMonth, isYearMonth } from '../../shared/fx';
import { lastCompleteMonth } from '../../shared/productCosts';
import { todayInTimezone } from '../../shared/dates';
import { getSettings } from '../repo/settings';
import { recordAudit } from '../repo/audit';
import { awsConfig, importAwsCosts } from '../aws/import';
import { AwsError } from '../aws/costExplorer';

export const awsRoutes = new Hono<{ Bindings: Env }>();

/** Whether the import can run, and if not, exactly what it is waiting for. */
awsRoutes.get('/aws/status', async (c) => {
  const settings = await getSettings(db(c));
  const { config, missing } = awsConfig(settings, envVars(c));
  return c.json({
    configured: config !== null,
    missing,
    tag_key: settings.aws_cost_tag_key,
    default_product_id: settings.aws_default_product_id,
  });
});

/**
 * Import AWS costs for a range of complete months, now.
 *
 * Defaults to the last twelve complete months, which is about as far back as
 * Cost Explorer keeps without its paid extended history. Re-running it is safe:
 * imported lines are replaced with the current figure and typed lines are kept.
 */
awsRoutes.post('/aws/import', async (c) => {
  const settings = await getSettings(db(c));
  const { config, missing } = awsConfig(settings, envVars(c));
  if (!config) {
    return c.json({ error: 'not_configured', message: `AWS import still needs: ${missing.join(', ')}.` }, 400);
  }

  const url = new URL(c.req.url);
  const latest = lastCompleteMonth(todayInTimezone(settings.timezone));
  const to = url.searchParams.get('to') ?? latest;
  const from = url.searchParams.get('from') ?? addMonthsToYearMonth(latest, -11);

  if (!isYearMonth(from) || !isYearMonth(to)) {
    return c.json({ error: 'bad_month', message: 'Use months in YYYY-MM form.' }, 400);
  }
  if (from > to) {
    return c.json({ error: 'bad_range', message: 'The start month is after the end month.' }, 400);
  }
  if (to > latest) {
    return c.json(
      { error: 'bad_range', message: `${to} has not finished yet. The latest complete month is ${latest}.` },
      400,
    );
  }

  try {
    const report = await importAwsCosts(db(c), config, { from, to });
    await recordAudit(db(c), {
      entity: 'product_cost',
      entity_id: 'aws',
      action: 'update',
      actor: actor(c),
      summary: `Imported ${report.saved.length} AWS cost line(s), ${from} to ${to}`,
    });
    return c.json(report);
  } catch (error) {
    if (error instanceof AwsError) {
      return c.json({ error: 'aws_error', message: error.message }, 502);
    }
    throw error;
  }
});
