import readExcelFile from 'read-excel-file/node';

export type TextExport = { text: string; ext: 'csv' | 'xlsx'; mime: string };

const cell = (value: unknown) => {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

// A spreadsheet is read as the table it holds: the sheet with the most rows
// (a summary sheet is shorter than the statement), with dates as dates.
async function fromExcel(buffer: Buffer): Promise<string | null> {
  try {
    const sheets = (await readExcelFile(buffer)) as { data: unknown[][] }[];
    const biggest = [...sheets].sort((a, b) => b.data.length - a.data.length)[0];
    if (!biggest || biggest.data.length === 0) return null;
    return biggest.data.map((row) => row.map(cell).join(',')).join('\n');
  } catch {
    return null;
  }
}

// A CSV or TSV download, or an Excel file saved as .xlsx, as plain text a
// statement reader can use. Anything else (a PDF, a picture, a binary) is null.
export async function readExport(buffer: Buffer): Promise<TextExport | null> {
  if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return null;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    const text = await fromExcel(buffer);
    return text === null ? null : { text, ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  if (buffer.subarray(0, 4096).includes(0)) return null;
  const text = buffer.toString('utf8');
  return text.includes('�') ? null : { text, ext: 'csv', mime: 'text/csv' };
}
