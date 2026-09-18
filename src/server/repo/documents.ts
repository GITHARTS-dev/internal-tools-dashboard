import { nowIso, uuid, type Db } from './db';
import type { ToolDocument } from '../../shared/types';
import type { DocumentCreateInput } from '../../shared/schema';

/**
 * Contracts and invoices.
 *
 * Built and stored, but gated behind the FEATURE_DOCUMENTS flag (off by
 * default) until it is decided whether invoices are kept at all or only their
 * amounts are recorded. Turning it on is a config change, not a migration.
 */

export async function listDocuments(db: Db, toolId: string): Promise<ToolDocument[]> {
  const { results } = await db
    .prepare('SELECT * FROM documents WHERE tool_id = ? ORDER BY created_at DESC')
    .bind(toolId)
    .all<ToolDocument>();
  return results;
}

export async function createDocument(db: Db, input: DocumentCreateInput): Promise<ToolDocument> {
  const id = uuid();
  await db
    .prepare(
      `INSERT INTO documents (id, tool_id, kind, title, external_url, file_key, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.tool_id, input.kind, input.title, input.external_url ?? null, input.file_key ?? null, input.uploaded_by ?? null, nowIso())
    .run();

  const created = await db.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<ToolDocument>();
  if (!created) throw new Error('Document vanished immediately after insert');
  return created;
}

export async function deleteDocument(db: Db, id: string): Promise<void> {
  await db.prepare('DELETE FROM documents WHERE id = ?').bind(id).run();
}
