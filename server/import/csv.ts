// A small RFC 4180 reader. Pocket, Raindrop and mymind all export CSV, the
// repo has no dependency budget for a parser, and a hand-rolled split(',')
// breaks on exactly the cells that matter (a quoted note with a comma or a
// newline in it). One single-pass state machine, shared.
//
// The input is an untrusted upload, so nothing here throws: an unterminated
// quote reads to end of file, short rows are padded, long rows are cut.

const MAX_ROWS = 100_000
// One hostile multi-MB cell must not be held in memory twice (the decoded
// string plus the cell). The importers still apply their own per-field caps.
const MAX_CELL = 20_000
// csvHeader only ever needs the first line of a file that can be many MB.
const HEADER_BYTES = 4096

type Table = string[][]

function scan(text: string, maxRecords: number): { table: Table; truncated: boolean } {
  const table: Table = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let truncated = false

  const endCell = () => {
    row.push(cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell)
    cell = ''
  }
  // Returns false once the limit is hit so the caller stops scanning.
  const endRow = (): boolean => {
    endCell()
    // A blank line parses as a single empty cell; it is not a record.
    if (row.some(c => c !== '')) {
      if (table.length >= maxRecords) {
        truncated = true
        return false
      }
      table.push(row)
    }
    row = []
    return true
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch !== '"') cell += ch
      else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else inQuotes = false
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') endCell()
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      if (!endRow()) return { table, truncated }
    } else cell += ch
  }
  if (cell !== '' || row.length) endRow()
  return { table, truncated }
}

const decode = (buf: Buffer) => buf.toString('utf8').replace(/^﻿/, '')
const normaliseHeader = (cells: string[]) => cells.map(c => c.trim().toLowerCase())

export function readCsv(
  buf: Buffer,
  maxRows = MAX_ROWS,
): { header: string[]; rows: Record<string, string>[]; truncated: boolean } {
  // +1 for the header record, so maxRows counts data rows.
  const { table, truncated } = scan(decode(buf), maxRows + 1)
  const header = normaliseHeader(table[0] ?? [])
  const rows = table.slice(1).map(cells => {
    const out: Record<string, string> = {}
    header.forEach((h, i) => {
      out[h] = cells[i] ?? ''
    })
    return out
  })
  return { header, rows, truncated }
}

export function csvHeader(buf: Buffer): string[] {
  const head = decode(buf.subarray(0, HEADER_BYTES))
  const end = head.search(/[\r\n]/)
  const { table } = scan(end < 0 ? head : head.slice(0, end), 1)
  return normaliseHeader(table[0] ?? [])
}
