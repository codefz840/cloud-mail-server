'use strict';

/**
 * Tests for IMAP utility functions (sequence set parsing, UID set parsing,
 * fetch item parsing).
 *
 * The helper functions below are local duplicates of the module-private
 * implementations in src/imap/imap-server.js.  They are kept in sync
 * manually to allow focused unit testing without exposing them as public API.
 */

// ---------------------------------------------------------------------------
// Replicate helper functions locally for unit testing
// (They mirror the implementations in src/imap/imap-server.js exactly)
// ---------------------------------------------------------------------------

function parseSequenceSet(set, total) {
  const result = new Set();
  const parts = set.split(',');
  for (const part of parts) {
    if (part.includes(':')) {
      let [lo, hi] = part.split(':').map(v => (v === '*' ? total : parseInt(v, 10)));
      if (lo > hi) [lo, hi] = [hi, lo];
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const n = part === '*' ? total : parseInt(part, 10);
      result.add(n);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function parseUidSet(set, uids) {
  const maxUid = uids.length > 0 ? Math.max(...uids) : 0;
  const result = new Set();
  const parts = set.split(',');
  for (const part of parts) {
    if (part.includes(':')) {
      let [lo, hi] = part.split(':').map(v => (v === '*' ? maxUid : parseInt(v, 10)));
      if (lo > hi) [lo, hi] = [hi, lo];
      for (const uid of uids) {
        if (uid >= lo && uid <= hi) result.add(uid);
      }
    } else {
      const uid = part === '*' ? maxUid : parseInt(part, 10);
      if (uids.includes(uid)) result.add(uid);
    }
  }
  return [...result].sort((a, b) => a - b);
}

function parseFetchItems(raw) {
  if (!raw) return [];
  const s = raw.trim();
  const macros = {
    ALL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'],
    FULL: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'],
    FAST: ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'],
  };
  if (macros[s.toUpperCase()]) return macros[s.toUpperCase()];

  const inner = s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
  const items = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === ' ') { i++; continue; }
    const bracketStart = inner.indexOf('[', i);
    const nextSpace = inner.indexOf(' ', i);
    if (bracketStart !== -1 && (nextSpace === -1 || bracketStart < nextSpace)) {
      const bracketEnd = inner.indexOf(']', bracketStart);
      if (bracketEnd !== -1) {
        items.push(inner.slice(i, bracketEnd + 1).toUpperCase());
        i = bracketEnd + 1;
        if (inner[i] === '<') {
          const pe = inner.indexOf('>', i);
          i = pe !== -1 ? pe + 1 : i + 1;
        }
        continue;
      }
    }
    const end = nextSpace === -1 ? inner.length : nextSpace;
    items.push(inner.slice(i, end).toUpperCase());
    i = end;
  }
  return items;
}

// ---------------------------------------------------------------------------
// parseSequenceSet
// ---------------------------------------------------------------------------
describe('parseSequenceSet', () => {
  test('single number', () => {
    expect(parseSequenceSet('3', 10)).toEqual([3]);
  });

  test('range', () => {
    expect(parseSequenceSet('2:4', 10)).toEqual([2, 3, 4]);
  });

  test('wildcard * maps to total', () => {
    expect(parseSequenceSet('*', 5)).toEqual([5]);
  });

  test('range with wildcard', () => {
    expect(parseSequenceSet('3:*', 5)).toEqual([3, 4, 5]);
  });

  test('comma-separated set', () => {
    expect(parseSequenceSet('1,3,5', 10)).toEqual([1, 3, 5]);
  });

  test('mixed set with range and singles', () => {
    expect(parseSequenceSet('1:3,5,7:8', 10)).toEqual([1, 2, 3, 5, 7, 8]);
  });

  test('reversed range is normalised', () => {
    expect(parseSequenceSet('5:3', 10)).toEqual([3, 4, 5]);
  });

  test('1:* returns all messages', () => {
    expect(parseSequenceSet('1:*', 3)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// parseUidSet
// ---------------------------------------------------------------------------
describe('parseUidSet', () => {
  const uids = [101, 105, 110, 200];

  test('single UID that exists', () => {
    expect(parseUidSet('105', uids)).toEqual([105]);
  });

  test('single UID that does not exist returns empty', () => {
    expect(parseUidSet('999', uids)).toEqual([]);
  });

  test('UID range', () => {
    expect(parseUidSet('105:110', uids)).toEqual([105, 110]);
  });

  test('wildcard maps to max UID', () => {
    expect(parseUidSet('*', uids)).toEqual([200]);
  });

  test('range with wildcard', () => {
    expect(parseUidSet('105:*', uids)).toEqual([105, 110, 200]);
  });
});

// ---------------------------------------------------------------------------
// parseFetchItems
// ---------------------------------------------------------------------------
describe('parseFetchItems', () => {
  test('empty string returns empty array', () => {
    expect(parseFetchItems('')).toEqual([]);
  });

  test('single item without parens', () => {
    expect(parseFetchItems('FLAGS')).toEqual(['FLAGS']);
  });

  test('multiple items in parens', () => {
    expect(parseFetchItems('(FLAGS UID RFC822.SIZE)')).toEqual(['FLAGS', 'UID', 'RFC822.SIZE']);
  });

  test('BODY[] item is parsed', () => {
    expect(parseFetchItems('BODY[]')).toEqual(['BODY[]']);
  });

  test('BODY[HEADER] item is parsed', () => {
    expect(parseFetchItems('BODY[HEADER]')).toEqual(['BODY[HEADER]']);
  });

  test('ALL macro expands', () => {
    expect(parseFetchItems('ALL')).toEqual(['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE']);
  });

  test('FULL macro expands', () => {
    expect(parseFetchItems('FULL')).toContain('BODY');
  });

  test('FAST macro expands', () => {
    expect(parseFetchItems('FAST')).toEqual(['FLAGS', 'INTERNALDATE', 'RFC822.SIZE']);
  });

  test('mixed: (FLAGS BODY[HEADER] UID)', () => {
    const items = parseFetchItems('(FLAGS BODY[HEADER] UID)');
    expect(items).toEqual(['FLAGS', 'BODY[HEADER]', 'UID']);
  });
});
