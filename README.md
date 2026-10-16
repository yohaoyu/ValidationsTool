# Standardized CIP Database Validation

A single-machine web tool for inspecting, validating, editing, and combining Capital Improvement Program (CIP) data that has been extracted from city PDFs into CSVs. It shows each CSV row side-by-side with its source PDF page, records your judgments, writes review state back into the data, and can merge a city's CSVs into a long-format dataset with a companion quality report.

> The in-app **Instructions** tab renders this file (`ValidationsTool/README.md`). Edit it and reload that tab to update what you see.

---

## What's New

### October 16, 2026

- **One city selector for the whole tool** — the City dropdown now sits at the right end of the
  title bar and drives **Quality Report, Manual Check and Combine** together. Pick a city once;
  the per-page City pickers are gone.
- **Offenders filter in Manual Check** — an **Investment Check** toggle next to the Validation
  Label filter. Click **All rows** to switch it to **Offenders only (N)** and the project list
  narrows to exactly the rows Section B flags (`|residual| > 2`). It combines with the Project
  Name / Project ID / Validation Label filters, works in single-file, All-files and Sample modes,
  and honours the **+ extra right-side columns** box on Page 1 so the two pages always agree.
  The set is fetched once per city and reset when the city changes.

### August 24, 2026

- **Find blank fields in Manual Check** — typing `(blank)` in the **Project Name** filter now lists the rows with an empty name, matching the behaviour the **Project ID** filter already had.

### June 16, 2026

- **Combine keeps everything** — the long-format output now carries `validation_label` and `notes` (after `plan_year` / `invest`) **and** any city-specific extra columns (e.g. `status`, `total_unfunded`). Rows marked `deleted` are still excluded.
- **Bulk duplicate cleanup (Section D)** — checkboxes per duplicate group, a one-click **Select all exact duplicates** (rows identical except `source_page`), and **Delete selected (keep one each)**.
- **Export Offenders** — an **Export CSV** button on the Offenders table downloads the full flagged list (all pages, reflecting the active status filter).
- **Status filter (Section B)** — when a city's data has a `status` column, filter the Project Investment Check by status value(s).
- **Live Sum / Residual** — the Manual Check detail panel shows an auto-computed `Σ year_* · Residual` row that updates as you edit and turns red when `|residual| > 2`.
- **Saved-sample banner** — Manual Check shows when a saved sample exists (with its creation time and % validated) and a **Load saved sample** button.
- **Reset** — a guarded **Remove all Validation Records** button (Combine page) wipes a city's review artifacts for a fresh start.
- **Smarter navigation** — clicking an Offender / duplicate opens the *exact* source row even when a file's name differs from its `cip_year` column; if a row's `project_id` is empty it filters by project name instead.
- **PDF tools** — **↻ Rotate**, a **Adjust** page offset, **Open Current PDF**, and **Open Current CSV**.

---

## Requirements & Setup

- **Python 3.9+**
- Install dependencies:
  ```bash
  pip install -r ValidationsTool/requirements.txt
  ```
  (Frontend libraries — PDF.js and marked.js — load from a CDN; nothing to install for them.)

### Run

```bash
./ValidationsTool/run.sh
```

This frees port 5050 if needed, starts Flask, and opens `http://localhost:5050` in your browser. Press **Ctrl+C** to stop. (Equivalent manual start: `cd ValidationsTool && python3 app.py`.)

---

## Folder Layout

```
CIPBD/
  <City>/                              ← one folder per city
    PDF/                               ← source CIP PDFs
    CSV/                               ← parsed CSVs (one per PDF)
    Validation/                        ← review artifacts for this city
      <stem>.json                      ← per-row verdicts, notes, edit history
      edit_log.md                      ← timestamped CSV edits & deletions
      sample.json                      ← saved random sample
    <City>_cip_long_MMDD.csv           ← long-format combine output
    <City>_cip_long_MMDD.md            ← companion markdown report
  ValidationsTool/                     ← this tool
    app.py
    README.md                          ← what you're reading now
    common_notes.md                    ← editable quick-pick notes (see Manual Check)
    requirements.txt
    run.sh
    static/ · templates/
```

Cities are discovered automatically — any folder under `CIPBD/` that contains both a `PDF/` and a `CSV/` subfolder appears in every city dropdown.

> **Note on year naming:** the report groups by the `cip_year` **column**, while the File dropdown lists file **names**. In some datasets (e.g. DC) the file name is offset from the `cip_year` column (`2011.csv` holds `cip_year` 2012). Clicking a project from the report always opens the exact source row, so the list and detail stay consistent regardless of this offset.

---

## Page 1 · Quality Report

Pick a city in the title bar and click **Run Validation**. (The City / Run bar stays pinned to the top as you scroll.) Rows marked `deleted` are excluded from the whole report.

- **A · Load Summary** — file count, total rows, unique project IDs, plan-year span. **Show more / Show less** expands the file list when it overflows.
- **B · Project Investment Check** — checks `project_total ≈ previous_appropriations + sum(year_*)`; rows where `|residual| > 2` ($K) are flagged.
  - **+ extra right-side columns** — add more columns to the right of the equation (comma-separated, then **Apply**).
  - **Filter calc by status** — appears only when the data has a `status` column; check one or more values to compute the check on that subset (Section A and the other sections stay on the full dataset).
  - *Flagged rows by CIP year* has a **Time Period** column (the investment year-range).
  - *Offenders* is paginated 10/page, has a **Label** column (hover to see its note), and an **Export CSV** button that downloads the full list. Click a project name to open it in **Manual Check** (it opens the exact row; if `project_id` is empty it filters by project name).
- **C · Column Completeness Check** — % of rows where each column is blank / NA / TBD, sorted high to low. `year_XXXX` and internal/computed columns are excluded. Use the **Scope** dropdown or **Prev / Next file** buttons to switch between city-wide and a single file.
- **D · Duplicate Projects Check** — rows sharing the same `project_id` within the same CIP year, with a **Label** column (hover for notes). Click a project ID to open the matching rows in **Manual Check**.
  - **Select all exact duplicates** checks every group whose rows are identical except `source_page` (only those get an enabled checkbox). **Delete selected (keep one each)** soft-deletes the extra copies, keeping one per group (reversible via Restore in Manual Check).

---

## Page 2 · Manual Check

Side-by-side verification — CSV row on the left, source PDF page on the right.

1. **Pick a city** in the title bar (it is shared with the Quality Report and Combine pages). The **File** dropdown defaults to **All files**, so every project across all files shows immediately (each row carries a file tag). Choose a specific file to narrow to it, or use **Sample**. If a saved sample exists, a banner shows its creation time and % validated, with a **Load saved sample** button.
2. **Click a row** → the PDF jumps to that row's `source_page`. PDF controls: **◀ Prev / Next ▶**, a page-number box, **↻ Rotate** (90° clockwise), **Adjust** (a page offset added to `source_page` when opening a row — default `0`, use e.g. `+2` when the PDF's physical pages are shifted), and **Open Current PDF** (opens the file in your OS default app).
3. **Edit a cell** → type into any value in *Project Information*, then **Save Edits** (next to **Open Current CSV**, which opens the file in your OS default app). The CSV is rewritten in place; the change is appended to `Validation/edit_log.md` and the row's `Validation/<stem>.json` record (with timestamps). A compact **Σ year_* · Residual** row at the bottom of the panel recomputes live as you edit (residual turns red when `|residual| > 2`).
4. **Record a verdict** → **✓ Correct** or **✗ Incorrect** (saved immediately). Add an optional **note** (saved on blur).
5. **Delete a project** → the **More** dropdown → *Delete project* → type a **required note** → **Confirm delete**. This is a soft delete (the row stays in the CSV but is labeled `deleted` and excluded from Combine and the Quality Report).
6. **Filters**: **Project Name**, **Project ID**, **Validation Label** (multi-select: validated / edited / incorrect / deleted), and **Investment Check** narrow the list in real time. The **Investment Check** toggle flips between **All rows** and **Offenders only (N)** — the rows flagged by the Project Investment Check (Section B), using the same equation and the same **+ extra right-side columns** setting as Page 1. In the **Project Name** and **Project ID** boxes, the literal query `(blank)` lists the rows whose name / ID is empty — the way to find unnamed or unnumbered projects, which a substring search cannot match.

Both note fields (verdict and delete) have a **+ Common note…** dropdown for quick-picking frequent notes; selecting one inserts (or appends) its text, and you can still type freely. Manage these in `ValidationsTool/common_notes.md` — each `- bullet` line becomes an option (headers and paragraphs are ignored).

### Validation label & notes (written into the CSV)

Each action writes two columns into the CSV:

- **`validation_label`** — derived state, by priority: `deleted` > `edited` > `validated` (Correct) > `incorrect` (Incorrect) > empty. "Edited" is sticky (an edit overrides a verdict); "deleted" wins until the row is restored (re-mark Correct/Incorrect).
- **`notes`** — the latest note from a verdict or deletion.

These two columns (plus `year_XXXX` and internal columns) are hidden from the editor and excluded from Column Completeness. They **are** carried into the long-format Combine output (placed after `plan_year` / `invest`).

### Sampling

- Enter a percentage (default **3%**) and click **Sample** — draws a random subset across all files, **guaranteeing at least one row per file**. Saved to `Validation/sample.json`.
- Clicking **Sample** again loads the saved set; **↻** regenerates; **✕ Exit sample** returns to All files.

### Resizable panels

Drag the **vertical** purple bar between the left panel and the PDF to change PDF width; drag the **horizontal** bar to change the row-list height.

---

## Page 3 · Combine

1. Pick a city in the title bar, click **Combine to Long CSV**.
2. Reads every CSV in `<City>/CSV/`, concatenates them, drops rows labeled `deleted`, then pivots `year_*` columns into long-format `(plan_year, invest)` rows (blank / zero allocations dropped).
3. Writes two timestamped files into `<City>/` (never overwriting — adds `_HHMM` / `_HHMMSS` if needed):
   - **`<City>_cip_long_MMDD.csv`** — long-format data. Columns: the standard ID columns, any **extra city-specific columns**, then `plan_year`, `invest`, `validation_label`, `notes`.
   - **`<City>_cip_long_MMDD.md`** — markdown report (see sections below).
4. On success the page shows a confirmation, **renders the report inline**, and offers **Open CSV** and **Open report (.md)** buttons (open the files in your OS default apps).

The report contains:
- **Summary** — files, rows, unique projects, plan-year range, human-reviewed count + %, and a **Label breakdown** (per-label share of reviewed).
- **Project Investment Check** — flagged-by-year and offenders.
- **Column Completeness** — city-wide and a combined per-file table.
- **Duplicate Projects Check.**
- **Review Records** — every row labeled incorrect / edited / deleted, with its note and full edit history.

### Remove all Validation Records (danger zone)

The **⚠ Remove all Validation Records** button (next to Combine) wipes a single city's review artifacts for a fresh start: deletes `Validation/sample.json` and every per-file `Validation/<stem>.json`, and drops the `validation_label` / `notes` columns from every CSV. Your CSV cell edits, `edit_log.md`, combine outputs, and PDFs are preserved. It requires typing a confirmation phrase (`RESET <City>`) and is irreversible.

---

## Page 4 · Instructions

Renders this `README.md`. Edit the file and reload the tab to update it.

---

## Tips

- **Single-user, single-machine.** Two browsers on the same instance can overwrite each other's edits.
- **Back up before bulk editing.** Edits write through to the CSV immediately — copy the city's `CSV/` folder somewhere safe before a heavy session.
- **Adding a new city.** Drop a folder `CIPBD/<NewCity>/` containing `PDF/` and `CSV/`; reload any city dropdown and it appears.
- **"Open" buttons** launch files in your OS default apps and only work because the server runs on the same machine as the browser (the intended setup).
- **Customizing quick notes.** Edit `ValidationsTool/common_notes.md` (bullet items only); reopen the Manual Check tab to pick up changes.
- **Restarting.** `lsof -ti:5050 | xargs kill -9` to stop, then `./ValidationsTool/run.sh` to start again.
