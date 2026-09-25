import { Hono } from 'hono';
import { documentCreateSchema } from '../../shared/schema';
import type { Env, Variables } from '../context';
import { actor, db, featureDocuments, zodErrorResponse } from '../context';
import { createDocument, deleteDocument, listDocuments } from '../repo/documents';
import { recordAudit } from '../repo/audit';

/**
 * Contracts and invoices, gated behind FEATURE_DOCUMENTS.
 *
 * The flag is off by default until it is decided whether invoices are stored
 * at all or only their amounts recorded. With the flag off these endpoints
 * answer 404, so nothing half-built is reachable.
 */
export const documentsRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

documentsRoutes.use('*', async (c, next) => {
  if (!featureDocuments(c)) {
    return c.json(
      {
        error: 'feature_disabled',
        message: 'Document storage is turned off. Set FEATURE_DOCUMENTS=true to enable it.',
      },
      404,
    );
  }
  await next();
});

documentsRoutes.get('/:toolId', async (c) => {
  const documents = await listDocuments(db(c), c.req.param('toolId'));
  return c.json({ documents });
});

documentsRoutes.post('/', async (c) => {
  const parsed = documentCreateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json(zodErrorResponse(parsed.error), 400);

  const document = await createDocument(db(c), parsed.data);
  await recordAudit(db(c), {
    entity: 'document',
    entity_id: document.id,
    action: 'create',
    actor: actor(c),
    summary: `Attached "${document.title}"`,
  });
  return c.json({ document }, 201);
});

documentsRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await deleteDocument(db(c), id);
  await recordAudit(db(c), {
    entity: 'document',
    entity_id: id,
    action: 'delete',
    actor: actor(c),
    summary: 'Removed a document',
  });
  return c.json({ ok: true });
});
