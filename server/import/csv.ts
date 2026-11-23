// A small RFC 4180 reader. Pocket, Raindrop and mymind all export CSV, the
// repo has no dependency budget for a parser, and a hand-rolled split(',')
// breaks on exactly the cells that matter (a quoted note with a comma or a
// newline in it). One single-pass state machine, shared.
//
// The input is an untrusted upload, so nothing here throws: an unterminated
// quote reads to end of file (and says so), short rows are padded, long rows
// are cut.
//
// Cells are built from slices of the input, never a character at a time:
// `cell += ch` left a one-character cons-string per byte in the rows, and a
// 45 MB export held 1.4 GB of heap after GC — one 64 MB ZIP entry could OOM
// the container.

const MAX_ROWS = 100_000
// One hostile multi-MB cell must not be held in memory twice (the decoded
// string plus the cell). The importers still apply their own per-field caps.
const MAX_CELL = 20_000
// csvHeader only ever needs the first line of a file that can be many MB.
const HEADER_BYTES = 4096

type Table = string[][]

function scan(text: string, maxRecords: number): { table: Table; truncated: boolean; unterminated: boolean } {
  const table: Table = []
  let row: string[] = []
  let cell = ''
  let truncated = false
  let unterminated = false

  // Past the cap the scan goes on (the cell's end is still to be found) but
  // stops keeping text.
  const append = (part: string) => {
    if (cell.length < MAX_CELL) cell += part
  }
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

  let i = 0
  while (i < text.length) {
    // A quote opens a quoted cell only as the cell's first character. Anywhere
    // else it is literal: an unquoted Pocket title `A 5" screen review` opened
    // quote mode, swallowed every later row, and the import reported an empty
    // export.
    if (text[i] === '"') {
      i++
      for (;;) {
        const q = text.indexOf('"', i)
        if (q < 0) {
          append(text.slice(i))
          i = text.length
          unterminated = true
          break
        }
        append(text.slice(i, q))
        if (text[q + 1] !== '"') {
          i = q + 1
          break
        }
        append('"')
        i = q + 2
      }
    }
    // The unquoted cell, or whatever follows a closing quote up to the delimiter.
    let end = i
    while (end < text.length && text[end] !== ',' && text[end] !== '\n' && text[end] !== '\r') end++
    append(text.slice(i, end))
    i = end
    if (i >= text.length) break
    if (text[i] === ',') endCell()
    else {
      if (text[i] === '\r' && text[i + 1] === '\n') i++
      if (!endRow()) return { table, truncated, unterminated }
    }
    i++
  }
  if (cell !== '' || row.length) endRow()
  return { table, truncated, unterminated }
}

const decode = (buf: Buffer) => buf.toString('utf8').replace(/^﻿/, '')
const normaliseHeader = (cells: string[]) => cells.map(c => c.trim().toLowerCase())

export function readCsv(
  buf: Buffer,
  maxRows = MAX_ROWS,
): { header: string[]; rows: Record<string, string>[]; truncated: boolean; unterminated: boolean } {
  // +1 for the header record, so maxRows counts data rows.
  const { table, truncated, unterminated } = scan(decode(buf), maxRows + 1)
  const header = normaliseHeader(table[0] ?? [])
  const rows = table.slice(1).map(cells => {
    const out: Record<string, string> = {}
    header.forEach((h, i) => {
      out[h] = cells[i] ?? ''
    })
    return out
  })
  return { header, rows, truncated, unterminated }
}

export function csvHeader(buf: Buffer): string[] {
  const head = decode(buf.subarray(0, HEADER_BYTES))
  const end = head.search(/[\r\n]/)
  const { table } = scan(end < 0 ? head : head.slice(0, end), 1)
  return normaliseHeader(table[0] ?? [])
}
