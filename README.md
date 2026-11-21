# csv-reader-speed-01 — a faster drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/Riel666/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/Riel666/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

`run(input)` returns exactly what make.fun's own csv-reader 1.0.0 returns for
every input `{text, header}`: the JSON value `{columns, rows, errors}`. It is
a from-scratch reimplementation of csv-reader's reading policy, written for
speed; the reference implementation was read to learn the semantics, then the
code here was written independently.

## Approach

The reference reads the text one character at a time and builds every field
up a character at a time. This implementation never does that:

- **Whole-line fast path.** A record whose line holds no quote and no stray
  CR is answered with one `slice` and one native `split(',')`. (The only CR
  such a line may hold is the CRLF terminator at its very end.)
- **Quoted fields by `indexOf` jumps.** A quoted field is read by jumping
  from quote to quote; each run between quotes is appended as one slice, with
  `""` collapsing to one quote. Only a run that holds a CR or LF gets a
  second look (CRLF and lone CR inside quotes each become one LF, and each
  counts one line). A quote with no closer is a literal character and the
  text after it is re-read as unquoted (`unterminated_quote`); what follows
  a closing quote up to the next comma or line break is appended as it
  stands (`quote_junk` when the field ends).
- **Unquoted fields without a per-character loop.** Most unquoted fields end
  at a comma before the record's next line break, so one `indexOf(',')` and
  one slice answers them (the slice is scanned for a stray CR). Anything
  else — a field ending at the line break, at the end of the text, or one
  holding a stray CR — falls through to a single regex scan for the next
  comma, CR or LF and one slice.
- **Errors in order, exactly as csv-reader records them:** `stray_cr` for a
  CR outside quotes that is not followed by LF, `unterminated_quote`,
  `quote_junk`, and `short_row` / `long_row` when a record ends, each
  `{code, line, row}` with `line` the 1-based line its record starts on
  (counting every LF, CRLF and lone CR inside quotes) and `row` its record's
  index in `rows` (`null` for the header). Lines with no characters are no
  records; a line holding only stray CRs is no record either, though its
  `stray_cr` errors stay. A U+FEFF at the very start is dropped. Fields stay
  strings, never trimmed or converted. `run` is pure: nothing is cached from
  one case to the next.

`main.ts` is the kit's house driver, kept as it ships: it turns V8's
incremental marking off before importing `solve.js`, reads every case from
`/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each with `run`, and
writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).

## How to run

Node 22.18 or later (the grader runs Node 22.23.4, which runs the
TypeScript driver as it is):

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

No dependencies, no install step, no network.

## Validation

All checks run locally on 2026-11-21 against csv-reader 1.0.0 (the kit's
`baselines/csv-reader/vendor/csv-reader/`, the oracle) and the kit's own
scorer and grader:

- **Kit grade-local** (`node cli/makefun.mjs grade-local --kit . --bot <repo>
  --driver process --worktree`): `passed: 1`, `cases_passed: 6`,
  `cases_total: 6`; scorer checks 6 of 6 points; the L1 regrade reproduced
  the outputs byte for byte. (The result hash differs from the server's
  only because this machine runs Node 24.22.1 while the harness runs
  26.13.1.)
- **Differential test vs the oracle, practice set** (6 cases, 10.19 MB of
  CSV): 6/6 answers byte-identical.
- **Hand-built edge cases** (105 nasty inputs × header true/false: BOM,
  CRLF inside and outside quotes, lone CRs, unterminated quotes, quote
  junk, `""` escapes, short/long rows, empty lines, lines of only stray
  CRs, missing trailing newline, quotes at the end of the text): 210/210
  byte-identical.
- **Fuzz** (30 fresh cases drawn with the kit's own subject generator
  `program/generator/subject/csv-cases.mjs`): 30/30 byte-identical.

### Speed (practice set, 6 cases, 10.19 MB, this machine)

- `run` only, interleaved runs against the house baseline in one process:
  **~135 ms vs ~425 ms per set, about 3.1× faster** (~75 MB/s vs ~24 MB/s).
- End to end through `main.ts` (Node startup, JSON parse of the 11 MB
  `cases.json`, `run`, JSON serialisation of the 12 MB answers): **~0.82 s
  vs ~1.75 s user CPU, about 2.1× faster**, with answers byte-identical.
  (Absolute times move with the machine's load; the ratio is the stable
  figure. The in-process solve-only comparison is the one the timing heat
  most resembles.)

## Layout

- `solve.js` — the entry: dependency-free ES module exporting `run`.
- `main.ts` — the driver the harness runs (the kit's house driver).
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT, Copyright (c) 2026 Ava.
- `.makefun/owner.json` — the claim file naming the entry's payout wallet.
