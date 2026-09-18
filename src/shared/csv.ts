/**
 * Minimal RFC 4180 CSV handling, shared by import and export so the file the
 * app produces is always a file the app will accept back.
 *
 * Written by hand rather than pulled in as a dependency: the format is small,
 * and the failure mode that matters (a vendor name containing a comma, or a
 * note containing a newline) is exactly what a naive split(',') gets wrong.
 */

export function toCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [headers.map(toCsvValue).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => toCsvValue(row[h])).join(','));
  }
  // Excel opens a BOM-prefixed file with the right encoding; without it,
  // rupee symbols and accented names arrive as mojibake.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Parse CSV text into rows of raw strings, honouring quotes and escapes. */
export function parseCsvRows(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (char === '\r') {
      i++;
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += char;
    i++;
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines produced by a final newline.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Parse into objects keyed by header. Headers are trimmed and lowercased. */
export function parseCsv(input: string): Array<Record<string, string>> {
  const rows = parseCsvRows(input);
  if (rows.length === 0) return [];
  const headers = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (row[index] ?? '').trim();
    });
    return record;
  });
}
