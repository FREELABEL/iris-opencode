---
category: Data & Atlas
level: beginner
tags: [excel, spreadsheet, csv, xlsx, datasets, ingest, import]
duration_min: 12
---
# Excel, spreadsheets and CSVs in IRIS — the five traps that cost a day

Everything here was measured on 2026-09-11 building a 395-row client case audit. Each one
produced a file that opened cleanly and looked finished.

Keywords: excel · xlsx · spreadsheet · csv · openpyxl · workbook · dropdown · validation ·
BOM · OOXML · upload · attachment

---

## 1 · Rebuilding a workbook silently strips its dropdowns

**`openpyxl`'s `delete_cols()` and `insert_cols()` move cells. They do NOT move data
validations.** The rules keep pointing at the old column letters, so they land on the wrong
cells or on nothing. No error, no warning, every value present.

The client spotted it in seconds, because those cells are **how the audit is performed**:

> "On the original one, it had yes-no windows... number differs, verified — it was all
> yes-no columns... Oh, it did. Okay. So that changed."

**The rule: when you regenerate an artefact someone works IN, the validations, dropdowns,
protected ranges, conditional formats and frozen panes are part of the artefact — not
decoration.** They are the difference between a document and a tool. A sheet like this is
not a report, it is a form.

Do not shift columns in place. Write the final column order, then attach validation LAST,
addressed from the header row you just wrote:

```python
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

headers = [c.value for c in ws[1]]
col = get_column_letter(headers.index('Verified?') + 1)
dv = DataValidation(type='list', formula1='"Yes,No,N/A"', allow_blank=True)
ws.add_data_validation(dv)
dv.add(f'{col}2:{col}{ws.max_row}')
```

Then fail the build if any were lost:

```python
n = len(ws.data_validations.dataValidation)
assert n == expected, f'validations lost: {n} of {expected}'
```

## 2 · PowerShell binds a multi-argument call into ONE argument

`AddPart $uri $type $content` passes a single array to the first parameter. It does not
error. On an OOXML build it produced mashed part URIs and a 2,279-byte corrupt .xlsx that
Excel refused. Inlining the part creation gave a valid 14,636-byte file.

**Use named parameters — `AddPart -Uri $uri -Type $type -Content $content` — or inline it.**
Agents on Windows write PowerShell with bash call syntax, and it fails silently.

## 3 · A UTF-8 BOM corrupts the first header for naive readers

PowerShell's `Out-File` and `Export-Csv` default to UTF-8 **with** BOM. The first column
header arrives as `ï»¿Law Firm`, and any code matching on the header name misses it.

Write with `-Encoding utf8NoBOM`, or in Python `open(path, 'w', encoding='utf-8')` — which
has never written one. Check with `head -c 3 file.csv | xxd`.

## 4 · Excel holds a file lock that blocks reading it

An open workbook cannot be read by `Compress-Archive` and often not by other tools. The
symptom looks like a permissions or corruption problem.

**Rebuild from the source rather than reading the open file**, or close Excel first. Python
can usually read with shared access where PowerShell cannot.

## 5 · Upload the .xlsx directly — do not zip it

The bloq file API used to accept `.docx`, `.pptx`, `.doc`, `.ppt` and every archive format
while rejecting `.xlsx`, so a workbook had to be zipped and the team told to unpack it.
**Fixed 2026-09-11** — `.xlsx`, `.xls`, `.xlsm` and the OpenDocument formats now upload
directly.

Use the path that reads the bytes back:

```
iris bloqs files upload <bloq-id> report.xlsx     # prints a sha256, verified server-side
iris bloqs files download <bloq-id>               # sha256 per file
```

Not `iris atlas files download <file-id>` — that takes a BLOQ id, and given a file id it
prints `0/0 downloaded` and exits 0.

---

## The shape underneath all five

Every one produced a file that **opened**, showed **every value**, and passed any check that
asked "did it write". The property that mattered — can someone still do the job in it — was
never measured.

Ask that question instead of the easy one.
