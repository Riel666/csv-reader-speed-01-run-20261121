// solve.js — a fast drop-in for csv-reader 1.0.0, make.fun's own CSV reader.
//
// It answers exactly what csv-reader 1.0.0 answers for every input {text, header}:
// the JSON value {columns, rows, errors}. The reading policy is csv-reader's own
// (a U+FEFF at the very start is dropped; a record ends at LF or CRLF and a line
// left with no characters is no record; outside quotes a CR not followed by LF is
// dropped as stray_cr; a field that opens with a quote runs to the next quote that
// is not doubled, "" inside it one quote and each CRLF or lone CR inside it read
// as LF; what follows its closing quote, up to the next comma or line break, is
// appended as it stands as quote_junk when the field ends; a quote that never
// closes is a literal character and the text after it is read again as unquoted
// as unterminated_quote; a quote inside an unquoted field is a literal character;
// fields stay strings, never trimmed or converted; columns is the first record
// when header is true, else null; rows holds the records after it, each padded
// with "" as short_row or cut as long_row to the first record's width; each error
// is {code, line, row}, in the order met, with line the 1-based line its record
// starts on and row its record's index in rows, null for the header).
//
// Speed comes from never reading the text one character at a time:
//   - a record whose line holds no quote and no stray CR is answered with one
//     slice and one native split on commas;
//   - a quoted field is read by jumping from quote to quote with indexOf, and
//     each run between quotes is appended as one slice (line breaks inside
//     quotes are the only runs that need a second look);
//   - an unquoted field is read by one regex scan for the next comma, CR or LF
//     and one slice, instead of a character loop with a string built up a
//     character at a time.
// Nothing is cached from one case to the next; run is pure.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text (the record ends). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The next delimiter of an unquoted field: a comma, a CR or an LF. */
const DELIM = /[,\r\n]/g;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended and how many characters were kept; `recordLine` and `recordRow` are
  // the record this field belongs to, for the errors it records.
  function readUnquoted(value, recordLine, recordRow) {
    let added = 0;
    let start = pos;
    while (true) {
      DELIM.lastIndex = pos;
      const m = DELIM.exec(text);
      if (m === null) {
        value += text.slice(start, n);
        added += n - start;
        pos = n;
        return { value, ended: END, added };
      }
      const i = m.index;
      const ch = m[0];
      if (ch === ',') {
        value += text.slice(start, i);
        added += i - start;
        pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (ch === '\n') {
        value += text.slice(start, i);
        added += i - start;
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (text.charCodeAt(i + 1) === 10) {
        value += text.slice(start, i);
        added += i - start;
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += text.slice(start, i);
      added += i - start;
      pos = i + 1;
      start = pos;
    }
  }

  while (pos < n) {
    // Lines with no characters are no records.
    let c = text.charCodeAt(pos);
    while (c === 10 || (c === 13 && text.charCodeAt(pos + 1) === 10)) {
      pos += c === 10 ? 1 : 2;
      line += 1;
      if (pos >= n) break;
      c = text.charCodeAt(pos);
    }
    if (pos >= n) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;

    // Fast path: the rest of this line holds no quote and no stray CR, so the
    // whole record is one slice split on commas (the only CR it may hold is
    // the CRLF terminator at its very end).
    const nl = text.indexOf('\n', pos);
    const segEnd = nl === -1 ? n : nl;
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= segEnd) {
      const cr = text.indexOf('\r', pos);
      if (cr === -1 || cr >= segEnd || (nl !== -1 && cr === segEnd - 1)) {
        const end = nl !== -1 && text.charCodeAt(segEnd - 1) === 13 ? segEnd - 1 : segEnd;
        const fields = text.slice(pos, end).split(',');
        pos = nl === -1 ? n : nl + 1;
        if (nl !== -1) line += 1;
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
        } else {
          if (fields.length < width) {
            errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
            while (fields.length < width) fields.push('');
          } else if (fields.length > width) {
            errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
          }
          rows.push(fields);
        }
        continue;
      }
    }

    // Slow path: this record holds a quote or a stray CR; read it field by field.
    const fields = [];
    let quoted = false;
    let ended = END;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const open = pos;
        const openLine = line;
        let value = '';
        let p = pos + 1;
        let closed = false;
        let closeAt = -1;
        while (true) {
          const qq = text.indexOf('"', p);
          if (qq === -1) break;
          let chunk = text.slice(p, qq);
          if (chunk.indexOf('\r') !== -1 || chunk.indexOf('\n') !== -1) {
            // CRLF and a lone CR inside quotes are each one LF, and each
            // counts one line.
            line += chunk.match(/\r\n|\r|\n/g).length;
            chunk = chunk.replace(/\r\n?/g, '\n');
          }
          if (text.charCodeAt(qq + 1) === 34) {
            value += chunk;
            value += '"';
            p = qq + 2;
            continue;
          }
          value += chunk;
          closeAt = qq;
          closed = true;
          break;
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = readUnquoted('"', recordLine, recordRow);
          fields.push(r.value);
          ended = r.ended;
        } else {
          pos = closeAt + 1;
          if (pos >= n) {
            fields.push(value);
            ended = END;
          } else {
            const cc = text.charCodeAt(pos);
            if (cc === 44) {
              pos += 1;
              fields.push(value);
              ended = COMMA;
            } else if (cc === 10) {
              pos += 1;
              line += 1;
              fields.push(value);
              ended = LINE_BREAK;
            } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              fields.push(value);
              ended = LINE_BREAK;
            } else {
              // What follows the closing quote is appended as it stands, up
              // to the next comma or line break.
              const r = readUnquoted(value, recordLine, recordRow);
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              fields.push(r.value);
              ended = r.ended;
            }
          }
        }
      } else {
        quoted = false;
        // Plain unquoted field, read inline. Most end at a comma before the
        // record's next line break (nl, found for the fast-path check above):
        // one indexOf for the comma and one slice answers those, with a scan
        // of the slice for a stray CR; anything else falls through to the
        // regex scan below, which also handles the line break, the end of the
        // text and stray CRs. (nl stays the next LF after pos while this
        // record runs: a field ends the record at nl, and a quoted field that
        // swallows an LF leaves pos past nl, so a comma before nl is a real
        // field end whenever this branch is reached.)
        const comma = text.indexOf(',', pos);
        if (comma !== -1 && (nl === -1 || comma < nl)) {
          const chunk = text.slice(pos, comma);
          if (chunk.indexOf('\r') === -1) {
            fields.push(chunk);
            pos = comma + 1;
            ended = COMMA;
            continue;
          }
        }
        let value = '';
        let start = pos;
        while (true) {
          DELIM.lastIndex = pos;
          const m = DELIM.exec(text);
          if (m === null) {
            value += text.slice(start, n);
            pos = n;
            ended = END;
            break;
          }
          const i = m.index;
          const ch = m[0];
          if (ch === ',') {
            value += text.slice(start, i);
            pos = i + 1;
            ended = COMMA;
            break;
          }
          if (ch === '\n') {
            value += text.slice(start, i);
            pos = i + 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          if (text.charCodeAt(i + 1) === 10) {
            value += text.slice(start, i);
            pos = i + 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          value += text.slice(start, i);
          pos = i + 1;
          start = pos;
        }
        fields.push(value);
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
