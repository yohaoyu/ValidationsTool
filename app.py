import re
import os
import sys
import json
import math
import random
import subprocess
import numpy as np
import pandas as pd
from pathlib import Path
from datetime import datetime
from flask import Flask, jsonify, request, send_file, render_template

TOOL_DIR = Path(__file__).parent            # ValidationsTool/
BASE_DIR = TOOL_DIR.parent                  # CIPBD/  (city folders, combine outputs)
TOL = 2  # |residual| tolerance in $K


def _val_dir(city):
    """Per-city folder holding verdicts, edit log, and sample.json."""
    return BASE_DIR / city / 'Validation'

ID_COLS = [
    'cip_year', 'project_type', 'source_page', 'department',
    'project_name', 'project_id', 'address_location',
    'start_year', 'end_year',
    'project_description', 'project_justification',
    'previous_appropriations', 'project_total',
]

LABEL_COL = 'validation_label'
NOTES_COL = 'notes'


def compute_label(rec):
    """Derive the CSV validation_label from a per-row audit record.

    Priority: deleted > edited > validated (correct) > incorrect > '' (none).
    """
    if rec.get('status') == 'deleted':
        return 'deleted'
    if rec.get('edits'):
        return 'edited'
    if rec.get('status') == 'correct':
        return 'validated'
    if rec.get('status') == 'incorrect':
        return 'incorrect'
    return ''


def _set_review_cell(csv_path, idx, label=None, notes=None):
    """Write the derived review columns (validation_label, notes) for one row.

    Only the columns provided (non-None) are updated; a single read/write.
    """
    if label is None and notes is None:
        return
    df = pd.read_csv(csv_path, dtype=str).fillna('')
    if label is not None and LABEL_COL not in df.columns:
        df[LABEL_COL] = ''
    if notes is not None and NOTES_COL not in df.columns:
        df[NOTES_COL] = ''
    if idx < len(df):
        if label is not None:
            df.at[idx, LABEL_COL] = label
        if notes is not None:
            df.at[idx, NOTES_COL] = notes
        df.to_csv(csv_path, index=False)


def gather_review_records(city):
    """Collect per-row review records labeled incorrect / edited / deleted.

    Reads every <stem>.json in the city's Validation folder (skipping sample.json)
    and returns a list of (record, label) sorted by file then row index.
    """
    out = []
    vdir = _val_dir(city)
    if not vdir.exists():
        return out
    for jp in sorted(vdir.glob('*.json')):
        if jp.name == 'sample.json':
            continue
        try:
            with open(jp, encoding='utf-8') as f:
                recs = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        for r in recs:
            label = compute_label(r)
            if label in ('incorrect', 'edited', 'deleted'):
                out.append((r, label))
    out.sort(key=lambda t: (str(t[0].get('file_stem', '')), t[0].get('row_index') or 0))
    return out


def gather_label_counts(city):
    """Count human-reviewed rows by validation label across the city's JSONs."""
    counts = {'validated': 0, 'edited': 0, 'incorrect': 0, 'deleted': 0}
    vdir = _val_dir(city)
    if not vdir.exists():
        return counts
    for jp in sorted(vdir.glob('*.json')):
        if jp.name == 'sample.json':
            continue
        try:
            with open(jp, encoding='utf-8') as f:
                recs = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue
        for r in recs:
            lbl = compute_label(r)
            if lbl in counts:
                counts[lbl] += 1
    return counts


_NUM_OK = re.compile(r'^-?\d+(?:\.\d+)?$')


def parse_money(x):
    if pd.isna(x):
        return 0.0
    s = str(x).strip()
    if s in ('', '-', 'nan', 'NaN', 'N/A', 'na', 'NA', 'TBD'):
        return 0.0
    neg = s.startswith('(') and s.endswith(')')
    s = s.strip('()').replace(',', '').replace('$', '').strip()
    if not _NUM_OK.match(s):
        return float('nan')
    v = float(s)
    return -v if neg else v


def safe(val):
    """Convert numpy/float types to JSON-serialisable Python types."""
    if isinstance(val, float) and math.isnan(val):
        return None
    if isinstance(val, (np.integer,)):
        return int(val)
    if isinstance(val, (np.floating,)):
        return float(val)
    return val


def get_cities():
    cities = []
    for p in sorted(BASE_DIR.iterdir()):
        if p.is_dir() and (p / 'PDF').is_dir() and (p / 'CSV').is_dir():
            cities.append(p.name)
    return cities


def get_files(city):
    city_dir = BASE_DIR / city
    pdf_stems = {p.stem: p.name for p in (city_dir / 'PDF').glob('*.pdf')}
    csv_stems = {p.stem: p.name for p in (city_dir / 'CSV').glob('*.csv')}
    pairs = []
    for stem in sorted(set(pdf_stems) & set(csv_stems)):
        pairs.append({'stem': stem, 'pdf': pdf_stems[stem], 'csv': csv_stems[stem]})
    return pairs


def run_validation(city, extra_cols=None):
    extra_cols = extra_cols or []
    csv_dir = BASE_DIR / city / 'CSV'
    city_slug = city.lower().replace(' ', '_')
    exclude = {f'{city_slug}_cip_quality_issues.csv', f'{city_slug}_cip_long.csv'}
    csv_files = sorted(p for p in csv_dir.glob('*.csv') if p.name not in exclude)

    if not csv_files:
        return {'error': 'No CSV files found'}

    dfs = []
    for p in csv_files:
        df = pd.read_csv(p, dtype=str).fillna('')
        df['source_file'] = p.name
        dfs.append(df)

    combined = pd.concat(dfs, ignore_index=True, sort=False).fillna('')
    for c in ID_COLS + [LABEL_COL, NOTES_COL]:
        if c not in combined.columns:
            combined[c] = ''

    year_cols = sorted(c for c in combined.columns if c.startswith('year_'))

    combined['_total_n'] = combined['project_total'].map(parse_money)
    combined['_prev_n'] = combined['previous_appropriations'].map(parse_money)

    try:
        year_numeric = combined[year_cols].applymap(parse_money)
    except AttributeError:
        year_numeric = combined[year_cols].map(parse_money)

    combined['year_sum'] = year_numeric.fillna(0).sum(axis=1)

    # Optional extra columns added to the right side of the equation
    valid_extra = [c for c in extra_cols if c and c in combined.columns]
    if valid_extra:
        extra_numeric = combined[valid_extra].apply(lambda s: s.map(parse_money))
        combined['_extra_sum'] = extra_numeric.fillna(0).sum(axis=1)
    else:
        combined['_extra_sum'] = 0.0

    valid_total = (
        combined['_total_n'].notna()
        & (combined['project_total'].astype(str).str.strip() != '')
    )
    combined['residual'] = (
        combined['_total_n'] - combined['_prev_n'].fillna(0)
        - combined['year_sum'] - combined['_extra_sum']
    )
    combined.loc[~valid_total, 'residual'] = float('nan')

    n_total = len(combined)
    n_with_total = int(valid_total.sum())
    n_no_total = int((~valid_total).sum())
    unique_project_ids = int(
        combined[combined['project_id'].astype(str).str.strip() != '']['project_id'].nunique()
    )

    # Per-column missing ratio (treat empty / whitespace / common null markers as missing)
    null_markers = {'', 'nan', 'na', 'n/a', 'tbd'}
    year_col_pattern = re.compile(r'^year_\d{4}$')
    skip_cols = {'source_file', LABEL_COL, NOTES_COL,
                 '_total_n', '_prev_n', 'year_sum', '_extra_sum', 'residual'}  # internal / computed columns

    def _missing_for(df):
        rows = []
        total = len(df)
        for col in df.columns:
            if col in skip_cols or year_col_pattern.match(col):
                continue
            norm = df[col].astype(str).str.strip().str.lower()
            missing = int(norm.isin(null_markers).sum())
            pct = (missing / total * 100) if total else 0.0
            rows.append({
                'column': col,
                'missing': missing,
                'total': total,
                'pct': round(pct, 1),
            })
        rows.sort(key=lambda x: -x['pct'])
        return rows

    missing_by_column = _missing_for(combined)

    # Per-file breakdown — keyed by stem so the frontend can match it to file selector
    file_stems = {f['csv']: f['stem'] for f in get_files(city)}
    missing_by_column_per_file = {}
    if 'source_file' in combined.columns:
        for source_file, group in combined.groupby('source_file'):
            stem = file_stems.get(source_file, str(source_file).removesuffix('.csv'))
            missing_by_column_per_file[stem] = _missing_for(group)

    abs_res = combined.loc[valid_total, 'residual'].abs()
    flagged = combined[combined['residual'].abs() > TOL].copy()

    buckets = {
        'le2': int((abs_res <= TOL).sum()),
        '2_100': int(((abs_res > TOL) & (abs_res <= 100)).sum()),
        '100_1000': int(((abs_res > 100) & (abs_res <= 1000)).sum()),
        'gt1000': int((abs_res > 1000).sum()),
    }

    by_year = flagged.groupby('cip_year').size()
    tot_year = combined[valid_total].groupby('cip_year').size()
    year_int_pat = re.compile(r'^year_(\d{4})$')
    year_cols_all = sorted(c for c in combined.columns if year_int_pat.match(c))
    period_nulls = {'', '-', 'nan', 'na', 'n/a', 'tbd'}

    def _time_period_for(group):
        populated = []
        for col in year_cols_all:
            s = group[col].astype(str).str.strip().str.lower()
            if (~s.isin(period_nulls)).any():
                populated.append(int(year_int_pat.match(col).group(1)))
        if not populated:
            return ''
        lo, hi = min(populated), max(populated)
        return f'{lo}' if lo == hi else f'{lo} – {hi}'

    flagged_by_year = []
    for yr in sorted(combined['cip_year'].unique()):
        f_n = int(by_year.get(yr, 0))
        t_n = int(tot_year.get(yr, 0))
        pct = round(100 * f_n / t_n, 1) if t_n else 0.0
        period = _time_period_for(combined[combined['cip_year'] == yr])
        flagged_by_year.append({
            'cip_year': str(yr),
            'time_period': period,
            'flagged': f_n,
            'total': t_n,
            'pct': pct,
        })

    meta_only_count = int(flagged[
        (flagged['_prev_n'].fillna(0) == 0) & (flagged['year_sum'] == 0)
    ].shape[0])

    # Duplicate detection — within same cip_year
    pid_clean = combined[combined['project_id'].astype(str).str.strip() != ''].copy()
    dup_id_grouped = (
        pid_clean.groupby(['cip_year', 'project_id'])
        .agg(
            count=('project_id', 'size'),
            project_name=('project_name', 'first'),
            source_pages=('source_page', lambda x: ', '.join(sorted({str(p) for p in x if str(p).strip()}))),
            labels=(LABEL_COL, lambda x: ', '.join(sorted({str(v) for v in x if str(v).strip()}))),
            notes=(NOTES_COL, lambda x: ' | '.join([str(v) for v in x if str(v).strip()])),
        )
        .reset_index()
    )
    dup_id_grouped = dup_id_grouped[dup_id_grouped['count'] > 1].sort_values('count', ascending=False)
    dup_id_total_groups = int(len(dup_id_grouped))
    dup_id_total_rows = int(dup_id_grouped['count'].sum()) if dup_id_total_groups else 0
    dup_id_list = [
        {
            'cip_year': str(r['cip_year']),
            'project_id': str(r['project_id']),
            'project_name': str(r['project_name']),
            'count': int(r['count']),
            'source_pages': r['source_pages'],
            'labels': r['labels'],
            'notes': r['notes'],
        }
        for _, r in dup_id_grouped.iterrows()
    ]

    show_cols = ['cip_year', 'source_page', 'project_id', 'project_name',
                 'previous_appropriations', 'project_total', 'year_sum', 'residual',
                 LABEL_COL, NOTES_COL]
    all_flagged = flagged.reindex(
        flagged['residual'].abs().sort_values(ascending=False).index
    )[show_cols]

    offenders_list = [
        {col: safe(row[col]) for col in show_cols}
        for _, row in all_flagged.iterrows()
    ]

    # Pass 2
    wide_for_melt = combined[ID_COLS + year_cols].copy()
    long = wide_for_melt.melt(
        id_vars=ID_COLS, value_vars=year_cols,
        var_name='plan_year', value_name='invest',
    )
    long['plan_year'] = long['plan_year'].str.replace('year_', '', regex=False)
    long['invest'] = long['invest'].astype(str).str.strip()
    long = long[~long['invest'].isin(['', '-', 'nan', 'NaN'])].copy()
    long['_invest_n'] = long['invest'].map(parse_money)
    long = long[long['_invest_n'].fillna(0) != 0].copy()

    distinct_projects = int(long.groupby(['cip_year', 'project_id']).ngroups) if len(long) else 0
    rows_by_year = [
        {'cip_year': str(yr), 'count': int(cnt)}
        for yr, cnt in long.groupby('cip_year').size().items()
    ] if len(long) else []
    bad_plan_years = int(len(long[~long['plan_year'].str.match(r'^\d{4}$')])) if len(long) else 0
    plan_year_range = [long['plan_year'].min(), long['plan_year'].max()] if len(long) else [None, None]

    return {
        'city': city,
        'csv_files': [p.name for p in csv_files],
        'total_rows': n_total,
        'unique_project_ids': unique_project_ids,
        'missing_by_column': missing_by_column,
        'missing_by_column_per_file': missing_by_column_per_file,
        'pass1': {
            'rows_with_total': n_with_total,
            'rows_missing_total': n_no_total,
            'residual_buckets': buckets,
            'flagged_by_year': flagged_by_year,
            'metadata_only': meta_only_count,
            'offenders': offenders_list,
        },
        'duplicates': {
            'by_id_groups': dup_id_total_groups,
            'by_id_rows': dup_id_total_rows,
            'by_id': dup_id_list,
        },
        'pass2': {
            'long_rows': int(len(long)),
            'distinct_projects': distinct_projects,
            'rows_by_cip_year': rows_by_year,
            'bad_plan_years': bad_plan_years,
            'plan_year_range': plan_year_range,
        },
    }


app = Flask(__name__)


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/cities')
def api_cities():
    return jsonify(get_cities())


@app.route('/api/cities/<city>/files')
def api_files(city):
    return jsonify(get_files(city))


@app.route('/api/cities/<city>/pdf/<path:filename>')
def api_pdf(city, filename):
    pdf_path = BASE_DIR / city / 'PDF' / filename
    return send_file(pdf_path, mimetype='application/pdf')


@app.route('/api/cities/<city>/csv/<stem>/rows')
def api_csv_rows(city, stem):
    files = get_files(city)
    match = next((f for f in files if f['stem'] == stem), None)
    if not match:
        return jsonify({'error': 'File not found'}), 404
    csv_path = BASE_DIR / city / 'CSV' / match['csv']
    df = pd.read_csv(csv_path, dtype=str).fillna('')
    rows = [
        {
            'index': int(i),
            'project_name': row.get('project_name', ''),
            'project_id': row.get('project_id', ''),
            'source_page': row.get('source_page', ''),
        }
        for i, row in df.iterrows()
    ]
    return jsonify(rows)


@app.route('/api/cities/<city>/all_rows')
def api_all_rows(city):
    """Every row across all of the city's files (for the 'All files' view)."""
    items = []
    for f in get_files(city):
        df = pd.read_csv(BASE_DIR / city / 'CSV' / f['csv'], dtype=str).fillna('')
        has_name = 'project_name' in df.columns
        has_id = 'project_id' in df.columns
        has_page = 'source_page' in df.columns
        has_label = LABEL_COL in df.columns
        for i in range(len(df)):
            items.append({
                'file_stem': f['stem'],
                'row_index': i,
                'project_name': str(df.at[i, 'project_name']) if has_name else '',
                'project_id': str(df.at[i, 'project_id']) if has_id else '',
                'source_page': str(df.at[i, 'source_page']) if has_page else '',
                'validation_label': str(df.at[i, LABEL_COL]) if has_label else '',
            })
    return jsonify(items)


@app.route('/api/cities/<city>/csv/<stem>/row/<int:idx>')
def api_csv_row(city, stem, idx):
    files = get_files(city)
    match = next((f for f in files if f['stem'] == stem), None)
    if not match:
        return jsonify({'error': 'File not found'}), 404
    csv_path = BASE_DIR / city / 'CSV' / match['csv']
    df = pd.read_csv(csv_path, dtype=str).fillna('')
    if idx >= len(df):
        return jsonify({'error': 'Row index out of range'}), 404
    row = df.iloc[idx]
    return jsonify({
        'columns': list(df.columns),
        'values': [str(v) for v in row.values],
        'source_page': row.get('source_page', ''),
    })


@app.route('/api/cities/<city>/csv/<stem>/row/<int:idx>', methods=['POST'])
def api_update_csv_row(city, stem, idx):
    data = request.get_json() or {}
    updates = data.get('updates', {})
    files = get_files(city)
    match = next((f for f in files if f['stem'] == stem), None)
    if not match:
        return jsonify({'error': 'File not found'}), 404
    csv_path = BASE_DIR / city / 'CSV' / match['csv']
    df = pd.read_csv(csv_path, dtype=str).fillna('')
    if idx >= len(df):
        return jsonify({'error': 'Row index out of range'}), 404

    old_values = {col: str(df.at[idx, col]) for col in updates if col in df.columns}
    changed = []
    for col, val in updates.items():
        if col in df.columns and str(df.at[idx, col]) != str(val):
            df.at[idx, col] = val
            changed.append(col)

    if changed:
        df.to_csv(csv_path, index=False)
        # Append diff to per-city markdown audit log
        log_dir = _val_dir(city)
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / 'edit_log.md'
        ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        proj_id = str(df.at[idx, 'project_id']) if 'project_id' in df.columns else ''
        proj_name = str(df.at[idx, 'project_name']) if 'project_name' in df.columns else ''
        src_page = str(df.at[idx, 'source_page']) if 'source_page' in df.columns else ''
        header = f'- {ts} — {city}/{stem} row {idx} [{proj_id} — {proj_name} p.{src_page}]'
        lines = [header]
        for col in changed:
            old = old_values.get(col, '').replace('\n', ' ').replace('"', '\\"')
            new = str(updates[col]).replace('\n', ' ').replace('"', '\\"')
            lines.append(f'  - **{col}**: "{old}" → "{new}"')
        with open(log_path, 'a', encoding='utf-8') as f:
            f.write('\n'.join(lines) + '\n')

        # Also append edits to per-row entry in <stem>.json (creating a stub if needed)
        val_path = log_dir / f'{stem}.json'
        records = []
        if val_path.exists():
            with open(val_path, encoding='utf-8') as f:
                records = json.load(f)
        entry = next((r for r in records if r.get('row_index') == idx), None)
        if entry is None:
            entry = {
                'timestamp': None,
                'city': city,
                'file_stem': stem,
                'row_index': idx,
                'project_name': proj_name,
                'project_id': proj_id,
                'source_page': src_page,
                'status': '',
                'notes': '',
                'edits': [],
            }
            records.append(entry)
        else:
            # Refresh project metadata in case the edit changed it
            entry['project_name'] = proj_name
            entry['project_id'] = proj_id
            entry['source_page'] = src_page
            entry.setdefault('edits', [])
        edit_ts = datetime.now().isoformat(timespec='seconds')
        for col in changed:
            entry['edits'].append({
                'timestamp': edit_ts,
                'column': col,
                'old': old_values.get(col, ''),
                'new': str(updates[col]),
            })
        with open(val_path, 'w', encoding='utf-8') as f:
            json.dump(records, f, indent=2)

        # Update the derived validation_label in the CSV (priority: deleted > edited > …)
        _set_review_cell(csv_path, idx, label=compute_label(entry))

    return jsonify({'ok': True, 'changed': changed})


def _md_cell(val):
    """Escape a cell value for a markdown table."""
    s = '' if val is None else str(val)
    return s.replace('|', '\\|').replace('\n', ' ')


def generate_combine_report(city, validation, csv_name, deleted_total=0):
    """Render a markdown audit report next to the combined CSV.

    Sections include the Quality Report stats from `validation`, but rows / years
    with no problems are omitted. A Review Records section lists every row labeled
    incorrect / edited / deleted (derived from the Validation JSON files).
    """
    L = []
    now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    L += [
        f'## {city} CIP Combine Report',
        '',
        f'**Generated:** {now_str}',
        f'**Output CSV:** `{csv_name}`',
        '',
        '---',
        '',
    ]

    # Summary
    pyr = validation['pass2'].get('plan_year_range') or [None, None]
    yr_text = f'{pyr[0]} – {pyr[1]}' if pyr[0] else '—'
    total_rows = validation['total_rows']
    label_counts = gather_label_counts(city)
    reviewed = sum(label_counts.values())
    rev_pct = (reviewed / total_rows * 100) if total_rows else 0.0
    L += [
        '### Summary',
        '',
        '| Metric | Value |',
        '|---|---|',
        f'| CSV files combined | {len(validation["csv_files"])} |',
        f'| Total input rows | {total_rows:,} |',
        f'| Unique project IDs | {validation["unique_project_ids"]:,} |',
        f'| Plan year range | {yr_text} |',
    ]
    if deleted_total:
        L.append(f'| Rows excluded as deleted | {deleted_total:,} |')
    L += [
        f'| Human-reviewed rows (any label) | {reviewed:,} |',
        f'| Reviewed % of total | {rev_pct:.2f}% |',
        '',
        '#### Label breakdown',
        '',
        '| Label | Count | % of reviewed |',
        '|---|---|---|',
    ]
    for lbl in ('validated', 'edited', 'incorrect', 'deleted'):
        n = label_counts[lbl]
        pct = (n / reviewed * 100) if reviewed else 0.0
        L.append(f'| {lbl} | {n:,} | {pct:.1f}% |')
    L.append('')

    # Investment check
    p1 = validation['pass1']
    b = p1['residual_buckets']
    res_gt2 = (b.get('2_100', 0) + b.get('100_1000', 0) + b.get('gt1000', 0))
    L += [
        '### Project Investment Check',
        '',
        '| Metric | Value |',
        '|---|---|',
        f'| Rows with total | {p1["rows_with_total"]:,} |',
        f'| Rows missing total | {p1["rows_missing_total"]:,} |',
        f'| Investment Residual &gt; 2 | {res_gt2:,} |',
        f'| Metadata-only flagged | {p1["metadata_only"]:,} |',
        '',
    ]

    # Flagged rows by CIP year — only show years with flagged > 0
    flagged_years = [y for y in p1['flagged_by_year'] if y['flagged'] > 0]
    L += ['#### Flagged rows by CIP year', '']
    if not flagged_years:
        L += ['_No CIP years with flagged rows._', '']
    else:
        L += [
            '_Only CIP years with flagged rows shown._',
            '',
            '| CIP Year | Time Period | Flagged | Total | % |',
            '|---|---|---|---|---|',
        ]
        for y in flagged_years:
            period = y.get('time_period') or '—'
            L.append(
                f'| {y["cip_year"]} | {period} | {y["flagged"]} | {y["total"]} | {y["pct"]:.1f}% |'
            )
        L.append('')

    # Offenders
    offenders = p1.get('offenders', [])
    L += ['#### Offenders', '']
    if not offenders:
        L += ['_No offenders — all residuals within tolerance._', '']
    else:
        L += [
            f'{len(offenders)} row(s) with |residual| &gt; 2.',
            '',
            '| CIP Year | Page | Project ID | Project Name | Prev. Approp. | Project Total | Year Sum | Residual |',
            '|---|---|---|---|---|---|---|---|',
        ]
        for r in offenders:
            res = f'{r["residual"]:.1f}' if r.get('residual') is not None else '—'
            ys = f'{r["year_sum"]:.1f}' if r.get('year_sum') is not None else '—'
            L.append(
                f'| {_md_cell(r.get("cip_year"))} | {_md_cell(r.get("source_page"))} | '
                f'{_md_cell(r.get("project_id"))} | {_md_cell(r.get("project_name"))} | '
                f'{_md_cell(r.get("previous_appropriations"))} | {_md_cell(r.get("project_total"))} | '
                f'{ys} | {res} |'
            )
        L.append('')

    # Column Completeness
    missing_all = validation.get('missing_by_column', [])
    missing_per_file = validation.get('missing_by_column_per_file', {})
    L += ['### Column Completeness', '']

    # City-wide
    L += ['#### City-wide', '']
    cw_rows = [m for m in missing_all if m['missing'] > 0]
    if not cw_rows:
        L += ['_All columns are complete across the city._', '']
    else:
        L += [
            '_Only columns with missing values shown._',
            '',
            '| Column | Missing | Total | Missing % |',
            '|---|---|---|---|',
        ]
        for m in cw_rows:
            L.append(
                f'| {_md_cell(m["column"])} | {m["missing"]:,} | {m["total"]:,} | {m["pct"]:.1f}% |'
            )
        L.append('')

    # Per file — one combined table, File as its own column
    L += ['#### Per file', '']
    per_file_rows = []
    for stem, rows in sorted(missing_per_file.items()):
        for m in rows:
            if m['pct'] >= 50:
                per_file_rows.append((stem, m))
    if not per_file_rows:
        L += ['_No files with columns ≥ 50% missing._', '']
    else:
        L += [
            '_Columns with ≥ 50% missing, by file._',
            '',
            '| File | Column | Missing | Total | Missing % |',
            '|---|---|---|---|---|',
        ]
        for stem, m in per_file_rows:
            L.append(
                f'| {_md_cell(stem)} | {_md_cell(m["column"])} | '
                f'{m["missing"]:,} | {m["total"]:,} | {m["pct"]:.1f}% |'
            )
        L.append('')

    # Duplicates
    dup = validation['duplicates']
    L += [
        '### Duplicate Projects Check',
        '',
        '| Metric | Value |',
        '|---|---|',
        f'| Duplicate ID groups | {dup["by_id_groups"]:,} |',
        f'| Rows in ID duplicates | {dup["by_id_rows"]:,} |',
        '',
    ]
    if not dup['by_id']:
        L += ['_No duplicate project IDs found within the same CIP year._', '']
    else:
        L += [
            '| CIP Year | Project ID | Project Name | Count | Source Pages |',
            '|---|---|---|---|---|',
        ]
        for r in dup['by_id']:
            L.append(
                f'| {_md_cell(r["cip_year"])} | {_md_cell(r["project_id"])} | '
                f'{_md_cell(r["project_name"])} | {r["count"]} | {_md_cell(r["source_pages"])} |'
            )
        L.append('')

    # Review records — derived from the data (incorrect / edited / deleted) with notes + edit history
    L += ['### Review Records', '']
    L += ['_All rows labeled incorrect, edited, or deleted — with notes and edit history._', '']
    review = gather_review_records(city)
    if not review:
        L.append('_No incorrect / edited / deleted records._')
    else:
        for rec, label in review:
            stem = rec.get('file_stem', '')
            idx = rec.get('row_index')
            pid = rec.get('project_id', '')
            pname = rec.get('project_name', '')
            pg = rec.get('source_page', '')
            L.append(f'- {city}/{stem} row {idx} [{pid} — {pname} p.{pg}]')
            L.append(f'  - Validation label: {label}')
            L.append(f'  - Notes: {(rec.get("notes") or "").strip()}')
            edits = rec.get('edits') or []
            if edits:
                L.append('  - Edits history')
                for e in edits:
                    ts = str(e.get('timestamp', '')).replace('T', ' ')
                    col = e.get('column', '')
                    old = str(e.get('old', '')).replace('\n', ' ')
                    new = str(e.get('new', '')).replace('\n', ' ')
                    L.append(f'    - {ts}: **{col}**: "{old}" → "{new}"')
    L.append('')

    return '\n'.join(L)


@app.route('/api/cities/<city>/combine', methods=['POST'])
def api_combine(city):
    csv_dir = BASE_DIR / city / 'CSV'
    city_slug = city.lower().replace(' ', '_')
    exclude_suffixes = ('_cip_quality_issues.csv', '_cip_long.csv')
    csv_files = sorted(
        p for p in csv_dir.glob('*.csv')
        if not any(p.name.endswith(s) for s in exclude_suffixes)
        and not p.name.startswith(f'{city}_cip_long_')
        and not p.name.startswith(f'{city_slug}_cip_long_')
    )

    if not csv_files:
        return jsonify({'error': 'No CSV files found'}), 400

    dfs = []
    deleted_total = 0
    for p in csv_files:
        df = pd.read_csv(p, dtype=str).fillna('')
        if LABEL_COL in df.columns:
            before = len(df)
            df = df[df[LABEL_COL] != 'deleted'].reset_index(drop=True)
            deleted_total += before - len(df)
        df['source_file'] = p.name
        dfs.append(df)

    combined = pd.concat(dfs, ignore_index=True, sort=False).fillna('')
    for c in ID_COLS:
        if c not in combined.columns:
            combined[c] = ''

    year_cols = sorted(c for c in combined.columns if c.startswith('year_'))

    # Pass 2: melt wide → long
    wide_for_melt = combined[ID_COLS + year_cols].copy()
    long = wide_for_melt.melt(
        id_vars=ID_COLS, value_vars=year_cols,
        var_name='plan_year', value_name='invest',
    )
    long['plan_year'] = long['plan_year'].str.replace('year_', '', regex=False)
    long['invest'] = long['invest'].astype(str).str.strip()
    long = long[~long['invest'].isin(['', '-', 'nan', 'NaN'])].copy()
    long['_invest_n'] = long['invest'].map(parse_money)
    long = long[long['_invest_n'].fillna(0) != 0].copy()
    long = long.drop(columns=['_invest_n'])
    long = long.sort_values(
        ['cip_year', 'department', 'project_id', 'plan_year']
    ).reset_index(drop=True)
    long = long[ID_COLS + ['plan_year', 'invest']]

    # Generate output filename, never overwriting
    now = datetime.now()
    city_dir = BASE_DIR / city
    base = f'{city}_cip_long'
    candidates = [
        f'{base}_{now:%m%d}.csv',
        f'{base}_{now:%m%d_%H%M}.csv',
        f'{base}_{now:%m%d_%H%M%S}.csv',
    ]
    out_path = None
    for name in candidates:
        candidate = city_dir / name
        if not candidate.exists():
            out_path = candidate
            break
    if out_path is None:
        # Extremely unlikely fallback
        out_path = city_dir / f'{base}_{now:%m%d_%H%M%S}_{now.microsecond}.csv'

    long.to_csv(out_path, index=False)

    # Companion Markdown report (Page 1 stats + edits, problems only)
    md_path = out_path.with_suffix('.md')
    md_text = None
    try:
        validation = run_validation(city)
        md_text = generate_combine_report(city, validation, out_path.name,
                                          deleted_total=deleted_total)
        md_path.write_text(md_text, encoding='utf-8')
    except Exception as e:  # noqa: BLE001
        # Never let report generation block the combine itself
        md_path = None
        md_text = None
        print(f'[combine] report generation failed: {e}')

    return jsonify({
        'ok': True,
        'output_file': out_path.name,
        'output_path': str(out_path),
        'report_file': md_path.name if md_path else None,
        'report_path': str(md_path) if md_path else None,
        'report_markdown': md_text,
        'rows_excluded_deleted': int(deleted_total),
    })


def _os_open(p):
    """Open a resolved path in the OS default app, guarded to the data directory."""
    p = Path(p).resolve()
    if BASE_DIR.resolve() not in p.parents:
        return jsonify({'error': 'Path is outside the data directory'}), 403
    if not p.exists():
        return jsonify({'error': 'File not found'}), 404
    try:
        if sys.platform == 'darwin':
            subprocess.Popen(['open', str(p)])
        elif sys.platform.startswith('win'):
            os.startfile(str(p))  # noqa: S606 (local single-user tool)
        else:
            subprocess.Popen(['xdg-open', str(p)])
    except Exception as e:  # noqa: BLE001
        return jsonify({'error': str(e)}), 500
    return jsonify({'ok': True})


@app.route('/api/open', methods=['POST'])
def api_open_file():
    """Open a file (under CIPBD/) in the OS default application."""
    data = request.get_json() or {}
    raw = data.get('path')
    if not raw:
        return jsonify({'error': 'No path provided'}), 400
    return _os_open(raw)


@app.route('/api/cities/<city>/open_source', methods=['POST'])
def api_open_source(city):
    """Open the current file's CSV or PDF for a given stem in the OS default app."""
    data = request.get_json() or {}
    stem = data.get('stem')
    kind = data.get('kind')
    match = next((f for f in get_files(city) if f['stem'] == stem), None)
    if not match:
        return jsonify({'error': 'File not found'}), 404
    if kind == 'csv':
        return _os_open(BASE_DIR / city / 'CSV' / match['csv'])
    if kind == 'pdf':
        return _os_open(BASE_DIR / city / 'PDF' / match['pdf'])
    return jsonify({'error': 'kind must be csv or pdf'}), 400


@app.route('/api/validations/<city>/<stem>')
def api_get_validations(city, stem):
    val_path = _val_dir(city) / f'{stem}.json'
    if not val_path.exists():
        return jsonify([])
    with open(val_path) as f:
        return jsonify(json.load(f))


@app.route('/api/validations', methods=['POST'])
def api_save_validation():
    data = request.get_json()
    city = data.get('city')
    stem = data.get('file_stem')
    val_dir = _val_dir(city)
    val_dir.mkdir(parents=True, exist_ok=True)
    val_path = val_dir / f'{stem}.json'

    records = []
    if val_path.exists():
        with open(val_path) as f:
            records = json.load(f)

    row_idx = data.get('row_index')
    # Preserve any edits already recorded for this row by api_update_csv_row
    existing = next((r for r in records if r.get('row_index') == row_idx), None)
    prior_edits = existing.get('edits', []) if existing else []
    records = [r for r in records if r.get('row_index') != row_idx]
    new_rec = {
        'timestamp': datetime.now().isoformat(timespec='seconds'),
        'city': city,
        'file_stem': stem,
        'row_index': row_idx,
        'project_name': data.get('project_name', ''),
        'project_id': data.get('project_id', ''),
        'source_page': data.get('source_page'),
        'status': data.get('status'),
        'notes': data.get('notes', ''),
        'edits': prior_edits,
    }
    records.append(new_rec)
    with open(val_path, 'w') as f:
        json.dump(records, f, indent=2)

    # Persist the derived label + note into the CSV (also handles restore from 'deleted')
    match = next((f for f in get_files(city) if f['stem'] == stem), None)
    if match and row_idx is not None:
        _set_review_cell(BASE_DIR / city / 'CSV' / match['csv'], row_idx,
                         label=compute_label(new_rec), notes=data.get('notes', ''))
    return jsonify({'ok': True})


@app.route('/api/cities/<city>/csv/<stem>/row/<int:idx>/delete', methods=['POST'])
def api_delete_row(city, stem, idx):
    data = request.get_json() or {}
    note = (data.get('note') or '').strip()
    if not note:
        return jsonify({'error': 'A note is required to delete a project.'}), 400

    match = next((f for f in get_files(city) if f['stem'] == stem), None)
    if not match:
        return jsonify({'error': 'File not found'}), 404
    csv_path = BASE_DIR / city / 'CSV' / match['csv']
    df = pd.read_csv(csv_path, dtype=str).fillna('')
    if idx >= len(df):
        return jsonify({'error': 'Row index out of range'}), 404

    proj_id = str(df.at[idx, 'project_id']) if 'project_id' in df.columns else ''
    proj_name = str(df.at[idx, 'project_name']) if 'project_name' in df.columns else ''
    src_page = str(df.at[idx, 'source_page']) if 'source_page' in df.columns else ''

    val_dir = _val_dir(city)
    val_dir.mkdir(parents=True, exist_ok=True)
    val_path = val_dir / f'{stem}.json'
    records = []
    if val_path.exists():
        with open(val_path, encoding='utf-8') as f:
            records = json.load(f)
    existing = next((r for r in records if r.get('row_index') == idx), None)
    prior_edits = existing.get('edits', []) if existing else []
    records = [r for r in records if r.get('row_index') != idx]
    rec = {
        'timestamp': datetime.now().isoformat(timespec='seconds'),
        'city': city, 'file_stem': stem, 'row_index': idx,
        'project_name': proj_name, 'project_id': proj_id, 'source_page': src_page,
        'status': 'deleted', 'notes': note, 'edits': prior_edits,
    }
    records.append(rec)
    with open(val_path, 'w', encoding='utf-8') as f:
        json.dump(records, f, indent=2)

    _set_review_cell(csv_path, idx, label=compute_label(rec), notes=note)

    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with open(val_dir / 'edit_log.md', 'a', encoding='utf-8') as f:
        f.write(f'- {ts} — {city}/{stem} row {idx} [{proj_id} — {proj_name} p.{src_page}] **DELETED**\n')
        f.write(f'  - note: "{note}"\n')

    return jsonify({'ok': True})


@app.route('/api/cities/<city>/validate')
def api_validate(city):
    extra = request.args.get('extra', '')
    extra_cols = [c.strip() for c in extra.split(',') if c.strip()]
    return jsonify(run_validation(city, extra_cols=extra_cols))


@app.route('/api/instructions')
def api_instructions():
    md_path = TOOL_DIR / 'README.md'
    if not md_path.exists():
        return ('README not found at ValidationsTool/README.md.',
                404, {'Content-Type': 'text/plain; charset=utf-8'})
    return (md_path.read_text(encoding='utf-8'),
            200, {'Content-Type': 'text/markdown; charset=utf-8'})


@app.route('/api/common_notes')
def api_common_notes():
    """Quick-pick notes parsed from ValidationsTool/common_notes.md (bullet items only)."""
    p = TOOL_DIR / 'common_notes.md'
    notes = []
    if p.exists():
        for line in p.read_text(encoding='utf-8').splitlines():
            m = re.match(r'^\s*[-*]\s+(.+)', line)
            if m:
                notes.append(m.group(1).strip())
    return jsonify({'notes': notes})


def _generate_sample(city, percent=3.0, seed=None):
    """Random sample of ~percent% of all rows in a city, guaranteeing each file
    contributes at least one row."""
    files = get_files(city)
    rows_by_stem = {}
    all_rows = []
    for f in files:
        csv_path = BASE_DIR / city / 'CSV' / f['csv']
        df = pd.read_csv(csv_path, dtype=str).fillna('')
        bucket = []
        for i in range(len(df)):
            r = {
                'file_stem': f['stem'],
                'row_index': i,
                'project_name': str(df.at[i, 'project_name']) if 'project_name' in df.columns else '',
                'project_id': str(df.at[i, 'project_id']) if 'project_id' in df.columns else '',
                'source_page': str(df.at[i, 'source_page']) if 'source_page' in df.columns else '',
                'validation_label': str(df.at[i, LABEL_COL]) if LABEL_COL in df.columns else '',
            }
            bucket.append(r)
            all_rows.append(r)
        if bucket:
            rows_by_stem[f['stem']] = bucket

    total = len(all_rows)
    if total == 0:
        return {'items': [], 'total_rows': 0, 'sample_size': 0, 'percent': percent}

    target = max(len(rows_by_stem), int(round(total * percent / 100)))
    rng = random.Random(seed)

    sampled = []
    picked_keys = set()
    # Step 1: guarantee at least one row per file
    for stem, rows in rows_by_stem.items():
        pick = rng.choice(rows)
        sampled.append(pick)
        picked_keys.add((pick['file_stem'], pick['row_index']))

    # Step 2: fill remaining randomly without duplicates
    needed = target - len(sampled)
    if needed > 0:
        remaining = [r for r in all_rows
                     if (r['file_stem'], r['row_index']) not in picked_keys]
        if remaining:
            sampled.extend(rng.sample(remaining, min(needed, len(remaining))))

    # Stable display order: by file_stem, then row_index
    sampled.sort(key=lambda r: (r['file_stem'], r['row_index']))
    return {
        'items': sampled,
        'total_rows': total,
        'sample_size': len(sampled),
        'percent': percent,
    }


@app.route('/api/cities/<city>/sample', methods=['GET', 'POST'])
def api_sample(city):
    """POST = generate a new sample (overwrites existing); GET = read saved sample.

    POST body may include `percent` (default 3) and `force` (bool). If `force`
    is false and a saved sample exists, the saved one is returned instead.
    """
    sample_path = _val_dir(city) / 'sample.json'

    if request.method == 'GET':
        if not sample_path.exists():
            return jsonify({'items': [], 'total_rows': 0, 'sample_size': 0,
                            'percent': 3.0, 'exists': False})
        with open(sample_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data['exists'] = True
        return jsonify(data)

    body = request.get_json(silent=True) or {}
    percent = float(body.get('percent') or 3)
    force = bool(body.get('force'))

    if sample_path.exists() and not force:
        with open(sample_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        data['exists'] = True
        return jsonify(data)

    sample = _generate_sample(city, percent=percent)
    sample['generated_at'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    sample['city'] = city
    sample_path.parent.mkdir(parents=True, exist_ok=True)
    with open(sample_path, 'w', encoding='utf-8') as f:
        json.dump(sample, f, indent=2)
    sample['exists'] = True
    return jsonify(sample)


if __name__ == '__main__':
    app.run(debug=True, port=5050)
