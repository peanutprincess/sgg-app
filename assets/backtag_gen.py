#!/usr/bin/env python3
"""
SG Back-tag Generator
Usage: python3 backtag_gen.py artworks.pdf
Output: <name>_backtags_s1.svg, _s2.svg … (collected and merged to PDF by the caller)
"""

import sys, re, subprocess, textwrap, math, base64, tempfile, shutil
from pathlib import Path

# ── Sheet / label geometry — Avery 8163 (US Letter, 2×5, 4"×2") ──
# Coordinates from Avery 8163 / 5163 spec (72 pts/inch)
SHEET_W  = 612.0    # 8.5"
SHEET_H  = 792.0    # 11"
LABEL_W  = 288.0    # 4"
LABEL_H  = 144.0    # 2"
COL_X    = [11.25,  312.75]              # 0.15625" and 4.34375"
ROW_Y    = [36, 180, 324, 468, 612]     # 0.5", 2.5", 4.5", 6.5", 8.5"
COLS, ROWS = 2, 5
PER_SHEET  = COLS * ROWS   # 10

# Text metrics
GALLERY    = "Sebastian Gladstone"
GALLERY_FS = 8.0
ARTIST_FS  = 12.0
DATA_FS    = 10.0
LINE_H     = 13.8

# Image takes left ~44% of label, text gets right 56%
IMG_W      = 120.0   # image column width (pts)
IMG_PAD    = 8.0     # padding around image
TEXT_LEFT  = COL_X[0] + IMG_W   # where text starts in left col label
TEXT_W     = LABEL_W - IMG_W    # remaining width for text
TEXT_CX    = [COL_X[c] + IMG_W + TEXT_W / 2 for c in range(COLS)]


# ── 1. Parse PDF ──────────────────────────────────────────────

def extract_text(pdf_path):
    r = subprocess.run(['pdftotext', str(pdf_path), '-'], capture_output=True, text=True)
    return r.stdout

def extract_images(pdf_path, tmp_dir):
    """Extract embedded images from PDF in order. Returns sorted list of paths."""
    subprocess.run(
        ['pdfimages', '-all', str(pdf_path), str(tmp_dir / 'img')],
        capture_output=True
    )
    imgs = sorted(tmp_dir.glob('img-*.jpg')) + sorted(tmp_dir.glob('img-*.png'))
    return sorted(imgs)

def img_data_uri(path):
    """Base64-encode an image for SVG embedding."""
    mime = 'image/jpeg' if path.suffix.lower() in ('.jpg', '.jpeg') else 'image/png'
    data = base64.b64encode(path.read_bytes()).decode()
    return f'data:{mime};base64,{data}'

def parse_records(raw):
    # Catalogue # pattern: 1-5 letters then dots/spaces/digits, optional letter suffix
    # Matches: MG.2012.003, MG0026, FD 309S, FD19, DH37, MG.2023.001, etc.
    CAT_RE = re.compile(r'^[A-Za-z]{1,5}[\s\.\d]*\d[A-Za-z]?\s*$')
    # Skip gallery header lines
    SKIP   = re.compile(
        r'Sebastian Gladstone|Los Angeles|New York|'
        r'BRING THE|GALLERY|STORAGE|VIEWING ROOM|Hang in',
        re.IGNORECASE
    )

    all_lines = [l.strip() for l in raw.split('\n')
                 if l.strip() and not SKIP.search(l)]

    # Group lines into records — split after each cat# line
    raw_blocks, current = [], []
    for line in all_lines:
        current.append(line)
        if CAT_RE.match(line):
            raw_blocks.append(current)
            current = []
    # Discard trailing lines that never ended with a cat# (headers, notes, etc.)

    records = []
    for block in raw_blocks:
        if len(block) < 2:
            continue
        # Sanity check: last line must be a cat#
        if not CAT_RE.match(block[-1]):
            continue

        artist = block[0]
        cat    = block[-1].strip()
        mid    = block[1:-1]

        # Dimensions: last mid line with "H x" or "x … in." pattern
        dims = ''
        if mid and (re.search(r'\d.*".*H', mid[-1], re.IGNORECASE)
                    or re.search(r'\d.*\bin\.?\s*$', mid[-1], re.IGNORECASE)
                    or re.search(r'\d\s*[xX×]\s*\d', mid[-1])):
            dims = mid[-1]
            mid  = mid[:-1]

        # Title lines end at ", YEAR", ", YEAR-YEAR", or ", n.d."
        YEAR_END = re.compile(
            r',\s*((19|20)\d{2}(?:[-–]\d{2,4})?|n\.d\.)\s*$',
            re.IGNORECASE
        )
        title_lines, medium_lines, found_year = [], [], False
        for line in mid:
            if not found_year:
                title_lines.append(line)
                if YEAR_END.search(line):
                    found_year = True
            else:
                medium_lines.append(line)

        title_raw = ' '.join(title_lines)
        ym = YEAR_END.search(title_raw)
        if ym:
            year_raw = ym.group(1)
            title    = title_raw[:ym.start()].strip()
            # Only store a clean single year; for ranges/n.d. fold into title display
            clean = re.match(r'^(19|20)\d{2}$', year_raw)
            year  = year_raw if clean else ''
            if not clean and year_raw.lower() != 'n.d.':
                # date range — keep it attached to title
                title = title_raw[:ym.start()].strip() + ', ' + year_raw
            elif year_raw.lower() == 'n.d.':
                title = title_raw[:ym.start()].strip()
        else:
            year  = ''
            title = title_raw

        records.append({
            'artist': artist,
            'title':  title,
            'year':   year,
            'medium': ' '.join(medium_lines),
            'dims':   dims,
            'cat':    cat,
        })
    return records


# ── 2. SVG generation ─────────────────────────────────────────

# Text area available per label (right side, minus padding)
TEXT_AVAIL_W = TEXT_W - 14        # pts available for text width
TEXT_AVAIL_H = LABEL_H - 22 - 10  # pts available for text height

def fit_font(rec):
    """
    Step down font size until all text fits in TEXT_AVAIL_W × TEXT_AVAIL_H.
    Returns (data_fs, artist_fs, line_h, wrap_chars)
    """
    # Georgia: avg char ≈ 0.54 × font_size
    for dfs in [10.0, 9.5, 9.0, 8.5, 8.0, 7.5, 7.0, 6.5, 6.0]:
        afs   = dfs * 1.2          # artist name slightly bigger
        lh    = dfs * 1.42         # line height
        cpw   = max(8, int(TEXT_AVAIL_W / (dfs * 0.54)))  # chars per wrap width

        lines = 1  # artist (bold)
        if rec['title'] or rec['year']:
            ts = f"{rec['title']}, {rec['year']}" if rec['title'] and rec['year'] else rec['title'] or rec['year']
            lines += max(1, len(textwrap.wrap(ts, cpw)))
        if rec['medium']:
            lines += max(1, len(textwrap.wrap(rec['medium'], cpw)))
        if rec['dims']:
            lines += 1
        if rec['cat']:
            lines += 1

        total_h = afs + (lines - 1) * lh
        if total_h <= TEXT_AVAIL_H:
            return dfs, afs, lh, cpw

    # Absolute minimum — just return smallest and let it clip
    return 6.0, 7.2, 8.5, max(8, int(TEXT_AVAIL_W / (6.0 * 0.54)))

def esc(s):
    return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')

def wrapped_tspans(text, cx, max_chars, style, first_dy, cont_dy=None):
    """Return list of <tspan> strings, wrapping text at max_chars.
    cont_dy: line-height for continuation lines; defaults to first_dy if not given."""
    if not text:
        return []
    if cont_dy is None:
        cont_dy = first_dy
    lines = textwrap.wrap(text, width=max_chars) or [text]
    spans = []
    for i, line in enumerate(lines):
        dy = first_dy if i == 0 else cont_dy
        spans.append(
            f'<tspan x="{cx:.2f}" dy="{dy:.2f}" style="{style}">{esc(line)}</tspan>'
        )
    return spans

def label_svg(rec, col_i, row_i, img_uri=None):
    col_x = COL_X[col_i]
    row_y = ROW_Y[row_i]
    cx    = TEXT_CX[col_i]

    # ── auto-fit font size to available text area ──
    dfs, afs, lh, cpw = fit_font(rec)

    # ── count total lines to vertically center the block ──
    a_lines  = 1
    ty_str   = (f"{rec['title']}, {rec['year']}" if rec['title'] and rec['year']
                else rec['title'] or rec['year'] or '')
    ty_lines = len(textwrap.wrap(ty_str, cpw)) or (1 if ty_str else 0)
    m_lines  = len(textwrap.wrap(rec['medium'], cpw)) if rec['medium'] else 0
    d_lines  = 1 if rec['dims'] else 0
    c_lines  = 1 if rec['cat']  else 0
    total_lines = a_lines + ty_lines + m_lines + d_lines + c_lines

    # Reserve 22pts at top for gallery name, 8pts padding at bottom
    usable   = LABEL_H - 22 - 8
    block_h  = afs + (total_lines - 1) * lh
    text_y   = row_y + 22 + max(4, (usable - block_h) / 2) + afs

    # ── artwork image (left side of label) ──
    img_el = ''
    if img_uri:
        img_x = col_x + IMG_PAD
        img_y = row_y + IMG_PAD
        img_h = LABEL_H - IMG_PAD * 2
        img_w = IMG_W - IMG_PAD * 2
        img_el = (
            f'<image x="{img_x:.2f}" y="{img_y:.2f}" '
            f'width="{img_w:.2f}" height="{img_h:.2f}" '
            f'preserveAspectRatio="xMidYMid meet" '
            f'href="{img_uri}"/>'
        )

    # ── gallery name (top of text area) ──
    gallery_y = row_y + 14
    gallery_el = (
        f'<text x="{cx:.2f}" y="{gallery_y:.2f}" text-anchor="middle" '
        f'font-family="Georgia, serif" font-size="{GALLERY_FS}" fill="#888888">'
        f'{esc(GALLERY)}</text>'
    )

    # ── artwork data tspans ──
    spans = []

    # Artist — bold, slightly larger than data size
    spans += wrapped_tspans(
        rec['artist'], cx, cpw,
        f'font-size:{afs:.1f}px;font-weight:700;font-family:Georgia,serif',
        0, lh
    )

    # Title italic + year
    if rec['title'] and rec['year']:
        title_full = f"{rec['title']}, {rec['year']}"
        spans += wrapped_tspans(title_full, cx, cpw,
            f'font-size:{dfs:.1f}px;font-style:italic;font-family:Georgia,serif', lh, lh)
    elif rec['title']:
        spans += wrapped_tspans(rec['title'], cx, cpw,
            f'font-size:{dfs:.1f}px;font-style:italic;font-family:Georgia,serif', lh, lh)
    elif rec['year']:
        spans += wrapped_tspans(rec['year'], cx, cpw,
            f'font-size:{dfs:.1f}px;font-family:Georgia,serif', lh, lh)

    # Medium
    if rec['medium']:
        spans += wrapped_tspans(rec['medium'], cx, cpw,
            f'font-size:{dfs:.1f}px;font-family:Georgia,serif', lh, lh)

    # Dimensions
    if rec['dims']:
        spans += wrapped_tspans(rec['dims'], cx, cpw,
            f'font-size:{dfs:.1f}px;font-family:Georgia,serif', lh, lh)

    # Catalogue #
    if rec['cat']:
        spans += wrapped_tspans(rec['cat'], cx, cpw,
            f'font-size:{dfs:.1f}px;font-family:Georgia,serif', lh, lh)

    data_el = (
        f'<text x="{cx:.2f}" y="{text_y:.2f}" text-anchor="middle">'
        + ''.join(spans) +
        '</text>'
    )

    return img_el + '\n' + gallery_el + '\n' + data_el


def make_sheet(records_10, img_uris_10):
    parts = []

    # Label content
    for i, rec in enumerate(records_10):
        if rec is None:
            continue
        img_uri = img_uris_10[i] if i < len(img_uris_10) else None
        parts.append(label_svg(rec, col_i=i % COLS, row_i=i // COLS, img_uri=img_uri))

    return f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{SHEET_W}pt" height="{SHEET_H}pt" viewBox="0 0 {SHEET_W} {SHEET_H}">
<rect width="{SHEET_W}" height="{SHEET_H}" fill="white"/>
{''.join(parts)}
</svg>'''


# ── 3. Main ───────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 backtag_gen.py artworks.pdf")
        sys.exit(1)

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(f"File not found: {pdf_path}")
        sys.exit(1)

    print(f"Parsing {pdf_path.name} ...")
    records = parse_records(extract_text(pdf_path))
    n_sheets = max(1, math.ceil(len(records) / PER_SHEET))
    print(f"Found {len(records)} artworks → {n_sheets} sheet(s)")

    tmp_dir = Path(tempfile.mkdtemp())
    try:
        img_paths = extract_images(pdf_path, tmp_dir)
        print(f"Extracted {len(img_paths)} images")
        img_uris = [img_data_uri(p) for p in img_paths]
        while len(img_uris) < len(records):
            img_uris.append(None)

        padded_rec = records + [None] * (-len(records) % PER_SHEET)
        padded_img = img_uris  + [None] * (-len(img_uris) % PER_SHEET)
        out_dir    = pdf_path.parent

        for s in range(len(padded_rec) // PER_SHEET):
            batch_r  = padded_rec[s * PER_SHEET:(s + 1) * PER_SHEET]
            batch_i  = padded_img[s * PER_SHEET:(s + 1) * PER_SHEET]
            svg_text = make_sheet(batch_r, batch_i)
            out_path = out_dir / f"{pdf_path.stem}_backtags_s{s+1}.svg"
            out_path.write_text(svg_text, encoding='utf-8')
            print(f"SVG:{out_path}")

    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

if __name__ == '__main__':
    main()
