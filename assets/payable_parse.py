#!/usr/bin/env python3
"""
Arternal Payable PDF Parser
Usage: python3 payable_parse.py /path/to/payable.pdf
Output: JSON with payNumber, date, notes, bscNumber, amount
"""
import sys, re, json, zlib
from pathlib import Path

# ── PDF text extraction (same engine as backtag_gen) ─────────────────────────

def _inflate(raw):
    for wbits in (15, -15, 47):
        try: return zlib.decompress(raw, wbits)
        except: pass
    return b''

def _parse_cmap(cmap_text):
    mapping = {}
    for block in re.finditer(r'beginbfchar(.*?)endbfchar', cmap_text, re.DOTALL):
        for m in re.finditer(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block.group(1)):
            dst = int(m.group(2), 16)
            if dst > 0: mapping[int(m.group(1), 16)] = chr(dst)
    for block in re.finditer(r'beginbfrange(.*?)endbfrange', cmap_text, re.DOTALL):
        for m in re.finditer(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', block.group(1)):
            start, end, u = int(m.group(1), 16), int(m.group(2), 16), int(m.group(3), 16)
            for g in range(start, end + 1):
                if u > 0: mapping[g] = chr(u + (g - start))
    return mapping

def _decode_hex_cmap(hex_str, cmap):
    hex_str = re.sub(r'\s', '', hex_str.strip('<>'))
    if not hex_str: return ''
    step = 4 if len(hex_str) >= 4 and len(hex_str) % 4 == 0 else 2
    return ''.join(cmap.get(int(hex_str[j:j+step], 16), '') for j in range(0, len(hex_str), step))

def _decode_pdf_string(s):
    s = s.strip()
    if not s: return ''
    if s.startswith('<'):
        hex_str = re.sub(r'\s', '', s[1:-1])
        if len(hex_str) % 2: hex_str += '0'
        try:
            raw = bytes.fromhex(hex_str)
            if raw[:2] == b'\xfe\xff': return raw.decode('utf-16', errors='replace')
            return raw.decode('latin-1', errors='replace')
        except: return ''
    s = s[1:-1]
    em = {'n':'\n','r':'\r','t':'\t','(':'(',')':")\",'\\\\':'\\\\'}
    out, i = [], 0
    while i < len(s):
        if s[i] == '\\' and i+1 < len(s):
            c = s[i+1]
            if c in em: out.append(em[c]); i += 2
            elif c.isdigit():
                j = 1
                while j < 3 and i+1+j < len(s) and s[i+1+j].isdigit(): j += 1
                try: out.append(chr(int(s[i+1:i+1+j], 8)))
                except: pass
                i += 1 + j
            else: out.append(c); i += 2
        else: out.append(s[i]); i += 1
    return ''.join(out)

def _stream_text(text, cmap):
    lines, current = [], []
    def sub_actual(m):
        return '(' + m.group(1).replace('\\','\\\\').replace('(','\\(').replace(')','\\)') + ') Tj '
    text = re.sub(r'/Span\s*<<[^>]*?/ActualText\s*\(([^)]*)\)[^>]*?>>\s*BDC.*?EMC\s*',
                  sub_actual, text, flags=re.DOTALL)
    for bt in re.finditer(r'BT\b(.*?)\bET\b', text, re.DOTALL):
        block, pos = bt.group(1), 0
        while pos < len(block):
            r = block[pos:]
            m = re.match(r'\s*([-\d.]+)\s+([-\d.]+)\s+T[dD]\b', r)
            if m:
                if float(m.group(2)) != 0 and current: lines.append(''.join(current)); current = []
                pos += m.end(); continue
            m = re.match(r'\s*T\*\b', r)
            if m:
                if current: lines.append(''.join(current)); current = []
                pos += m.end(); continue
            m = re.match(r'\s*[-\d.\s]+Tm\b', r)
            if m:
                if current: lines.append(''.join(current)); current = []
                pos += m.end(); continue
            m = re.match(r'\s*(\((?:[^\\()]|\\.)*\))\s+Tj\b', r)
            if m: current.append(_decode_pdf_string(m.group(1))); pos += m.end(); continue
            m = re.match(r'\s*(<[0-9A-Fa-f\s]+>)\s+Tj\b', r)
            if m: current.append(_decode_hex_cmap(m.group(1), cmap)); pos += m.end(); continue
            m = re.match(r'\s*\[(.*?)\]\s*TJ\b', r, re.DOTALL)
            if m:
                chunk = []
                for s in re.finditer(r'<([0-9A-Fa-f\s]*)>|(\((?:[^\\()]|\\.)*\))', m.group(1)):
                    chunk.append(_decode_hex_cmap('<'+s.group(1)+'>', cmap) if s.group(1) is not None else _decode_pdf_string(s.group(2)))
                current.append(''.join(chunk)); pos += m.end(); continue
            pos += 1
        if current: lines.append(''.join(current)); current = []
    return '\n'.join(lines)

def extract_text(pdf_path):
    data = Path(pdf_path).read_bytes()
    cmap, i = {}, 0
    while True:
        pos = data.find(b'stream', i)
        if pos == -1: break
        nl = data.find(b'\n', pos+6)
        if nl == -1: i = pos+6; continue
        s_end = data.find(b'endstream', nl+1)
        if s_end == -1: i = nl+1; continue
        raw = data[nl+1:s_end]
        dc = data[data.rfind(b'<<', max(0,pos-2000), pos):pos] if data.rfind(b'<<', max(0,pos-2000), pos) != -1 else b''
        content = _inflate(raw) if (b'FlateDecode' in dc or b'/Fl ' in dc) else raw
        if b'beginbfchar' in content or b'beginbfrange' in content:
            cmap.update(_parse_cmap(content.decode('latin-1', errors='replace')))
        i = s_end + 9
    parts, i = [], 0
    while True:
        pos = data.find(b'stream', i)
        if pos == -1: break
        nl = data.find(b'\n', pos+6)
        if nl == -1: i = pos+6; continue
        s_end = data.find(b'endstream', nl+1)
        if s_end == -1: i = nl+1; continue
        raw = data[nl+1:s_end]
        dc = data[data.rfind(b'<<', max(0,pos-2000), pos):pos] if data.rfind(b'<<', max(0,pos-2000), pos) != -1 else b''
        sub_m = re.search(rb'/Subtype\s*/(\w+)', dc)
        if sub_m and sub_m.group(1) == b'Image': i = s_end+9; continue
        content = _inflate(raw) if (b'FlateDecode' in dc or b'/Fl ' in dc) else raw
        if b'BT' in content and b'ET' in content:
            try: parts.append(_stream_text(content.decode('latin-1', errors='replace'), cmap))
            except: pass
        i = s_end + 9
    return '\n'.join(parts)

# ── Parse the payable text ────────────────────────────────────────────────────

def parse_payable(text):
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    pay_number  = ''
    date        = ''
    notes       = ''
    bsc_number  = ''
    amount      = ''

    # PAY number: PAY-XXXXX
    for l in lines:
        m = re.match(r'^(PAY-\d+)$', l)
        if m: pay_number = m.group(1); break

    # Date: Month Day, Year
    for l in lines:
        m = re.match(r'^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}$', l)
        if m: date = l; break

    # Notes: line after "To" / before the line item — typically "Based on..."
    # Find lines that look like notes (not gallery header, not artist/title)
    skip = {'Sebastian Gladstone', 'Sebastian Gladstone Gallery', 'Los Angeles | New York',
            'Los Angeles', 'New York', 'To', 'Bennet Schlesinger', 'TOTAL'}
    for l in lines:
        if l in skip: continue
        if re.match(r'^PAY-', l): continue
        if re.match(r'^(January|February|March|April|May|June|July|August|September|October|November|December)', l): continue
        if re.match(r'^\$', l): continue
        if re.match(r'^BSC', l): continue
        if 'consigned in' in l.lower(): continue
        if re.match(r'^Based on', l, re.IGNORECASE):
            notes = l; break

    # BSC number: BSC followed by digits
    for l in lines:
        m = re.match(r'^(BSC\d+)$', l)
        if m: bsc_number = m.group(1); break

    # Amount: $ X,XXX.XX USD (item line, not TOTAL)
    for l in lines:
        if l.upper().startswith('TOTAL'): continue
        m = re.search(r'\$\s*([\d,]+\.?\d*)\s*USD', l)
        if m:
            amount = m.group(1).replace(',', '')
            break

    return {
        'payNumber': pay_number,
        'date':      date,
        'notes':     notes,
        'bscNumber': bsc_number,
        'amount':    amount,
    }

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: payable_parse.py <pdf_path>'}))
        sys.exit(1)
    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(json.dumps({'error': f'File not found: {pdf_path}'}))
        sys.exit(1)
    try:
        text   = extract_text(pdf_path)
        result = parse_payable(text)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)
