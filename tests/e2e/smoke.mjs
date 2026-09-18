/**
 * End-to-end smoke test against the running app.
 *
 * Exercises the flows that matter through a real browser -- adding a tool,
 * marking a bill paid, previewing reminders, checking an import -- because a
 * passing unit test says the API is right, not that the screen works.
 *
 * Usage: npm run dev, then `npm run test:e2e`.
 */
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5173';
const CHROME = process.env.E2E_CHROME ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const failures = [];
let checks = 0;

function check(name, condition, detail = '') {
  checks++;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
    failures.push(name);
  }
}

const browser = await chromium.launch({ executablePath: CHROME });
const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
const page = await context.newPage();

const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

try {
  // --- Dashboard ---------------------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  check('dashboard shows the overdue payment', await page.getByText('payment is overdue').first().isVisible());
  check(
    'dashboard shows the closed cancellation window',
    await page.getByText('can no longer be cancelled').first().isVisible(),
  );
  check('KPI tiles render', (await page.locator('.stat').count()) >= 4);
  check('charts render as real SVG', (await page.locator('svg.chart').count()) >= 3);

  const showAll = page.getByRole('button', { name: /Show all \d+/ });
  if (await showAll.count()) {
    const before = await page.locator('.alert-row').count();
    await showAll.click();
    await page.waitForTimeout(250);
    check('“show all” expands the alert list', (await page.locator('.alert-row').count()) > before);
  }

  // --- Add a tool --------------------------------------------------------
  await page.goto(`${BASE}/tools/new`, { waitUntil: 'networkidle' });
  await page.fill('#name', 'E2E Test Tool');
  await page.fill('#cost', '1234.50');
  await page.fill('#owner_email', 'not-an-email');
  await page.getByRole('button', { name: 'Add tool' }).click();
  await page.waitForTimeout(800);
  check(
    'a bad email is rejected against its own field',
    await page.locator('#owner_email[aria-invalid="true"]').isVisible(),
  );
  check('the form stays put when validation fails', page.url().endsWith('/tools/new'));

  await page.fill('#owner_email', 'e2e@example.com');
  await page.fill('#renewal_date', '2027-01-15');
  await page.selectOption('#billing_cycle', 'annual');
  await page.getByRole('button', { name: 'Add tool' }).click();
  // Match a real id, not any trailing segment -- '/tools/new' satisfies a lazy
  // pattern and would leave every later step running against the empty form.
  const detailUrl = /\/tools\/[0-9a-f-]{36}$/;
  await page.waitForURL((url) => detailUrl.test(url.pathname), { timeout: 8000 });
  await page.waitForSelector('.detail-grid');
  check('the tool is created and opens its detail page', detailUrl.test(new URL(page.url()).pathname));
  check('the cost round-trips exactly', await page.getByText('₹1,234.50').first().isVisible());

  // --- Edit: the field we did not touch must survive ----------------------
  const toolUrl = page.url();
  await page.goto(`${toolUrl}/edit`, { waitUntil: 'networkidle' });
  await page.fill('#name', 'E2E Test Tool Renamed');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.waitForURL((url) => detailUrl.test(url.pathname), { timeout: 8000 });
  await page.waitForSelector('.detail-grid');
  const body = await page.textContent('body');
  check('rename works', body.includes('E2E Test Tool Renamed'));
  // Read the stored record rather than the page: a <select> renders every
  // option's text, so "Annual" appearing in the DOM proves nothing.
  const stored = await (await page.request.get(`${BASE}${new URL(page.url()).pathname.replace('/tools/', '/api/tools/')}`)).json();
  check('the untouched billing cycle is not reset to the default', stored.tool.billing_cycle === 'annual');
  check('the untouched cost survives the rename', stored.tool.cost_amount === 123450);

  // --- Schedule and settle a payment --------------------------------------
  await page.getByRole('button', { name: 'Schedule next payment' }).click();
  await page.waitForTimeout(900);
  check('a payment is scheduled from the tool’s own cycle', (await page.locator('tbody tr').count()) >= 1);

  await page.getByRole('button', { name: 'Mark paid' }).first().click();
  await page.waitForTimeout(900);
  check('the payment reads as paid', await page.getByText('Paid', { exact: true }).first().isVisible());

  // --- The change is recorded ----------------------------------------------
  const detail = await page.textContent('body');
  check('the change history records the rename', detail.includes('Updated name'));

  // --- Archive keeps history ----------------------------------------------
  await page.getByRole('button', { name: 'Mark cancelled' }).click();
  await page.waitForTimeout(900);
  const archived = await page.textContent('body');
  check('archiving explains that nothing was deleted', archived.includes('Nothing has been deleted'));
  check('the payment history survives archiving', (await page.locator('tbody tr').count()) >= 1);

  // --- Reminder preview ----------------------------------------------------
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Preview' }).click();
  await page.waitForTimeout(1200);
  const preview = await page.textContent('body');
  check('the dry run reports what would fire', /alerts? would be computed/.test(preview));
  check('the console channel is shown as ready', preview.includes('Ready'));

  // --- Import is previewed before it writes --------------------------------
  await page.fill(
    'textarea[placeholder="…or paste CSV here"]',
    'name,billing_cycle,cost,currency,renewal_date\nE2E Imported,monthly,99.00,INR,2027-02-01\n,monthly,10,INR,2027-02-01\n',
  );
  await page.getByRole('button', { name: 'Check the file' }).click();
  await page.waitForTimeout(900);
  const imported = await page.textContent('body');
  check('the import preview reports per-row outcomes', imported.includes('Would import'));
  check('a nameless row is rejected with a reason', imported.includes('No name'));

  const toolsAfterPreview = await (await page.request.get(`${BASE}/api/tools?search=E2E Imported`)).json();
  check('previewing an import writes nothing', toolsAfterPreview.tools.length === 0);

  // --- Payments ledger -----------------------------------------------------
  await page.goto(`${BASE}/payments`, { waitUntil: 'networkidle' });
  check('the ledger lists outstanding payments', (await page.locator('tbody tr').count()) > 0);
  await page.getByRole('button', { name: 'Paid', exact: true }).click();
  await page.waitForTimeout(800);
  check('the paid view loads', (await page.locator('tbody tr').count()) > 0);

  // --- History -------------------------------------------------------------
  await page.goto(`${BASE}/history`, { waitUntil: 'networkidle' });
  const history = await page.textContent('body');
  check('cancelled tools keep their lifetime spend', history.includes('Dropbox Business'));
  check('the archived test tool appears in history', history.includes('E2E Test Tool Renamed'));

  check('no uncaught errors anywhere', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
