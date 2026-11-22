// mend: apply AI-written edits in four formats to a tree of text files.
//
// Reads a patch (unified diff, SEARCH/REPLACE blocks, V4A patch, or JSON
// text-editor tool calls), finds the lines each edit names at the first of
// three matching tiers, and writes every change or none. See SPEC.md.
//
// Node 22 standard library only, zero dependencies, deterministic: no dates,
// no randomness, no network, no model calls.

import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** A parse fault, carrying the 1-based patch line it is reported at. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + String(line));
    this.line = line;
  }
}

/** A file split into lines, with its own line break and final-break flag. */
interface FileDoc {
  lines: string[];
  br: string;
  ends: boolean;
}

/** The outcome of applying one edit to the in-memory tree. */
type ApplyResult =
  | { ok: true; move?: { oldPath: string; newPath: string } }
  | { ok: false; code: string; path: string };

/** One edit of a patch: apply it to the tree, or report why it failed. */
interface Edit {
  apply(tree: Map<string, string>, strict: boolean): ApplyResult;
}

/** One line of a replacement: a context line (taken from the file) or a new line. */
interface NLine {
  ctx: boolean;
  oIndex: number;
  text: string;
}

function fail(code: string, path: string): ApplyResult {
  return { ok: false, code, path };
}

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isBlankLine(l: string): boolean {
  return l.trim() === '';
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimBothWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or .. */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

/** Split a file's text into lines at its own line break. */
function parseFile(text: string): FileDoc {
  let br = '\n';
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl - 1] === '\r') br = '\r\n';
  if (text === '') return { lines: [], br, ends: false };
  const parts = text.split(br);
  let ends = false;
  if (text.endsWith(br)) {
    ends = true;
    parts.pop();
  }
  return { lines: parts, br, ends };
}

/** Render a file back: its own break between lines, a final one exactly when it ended with one. */
function renderFile(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.ends ? doc.br : '');
}

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** Every 0-based position where O's lines match the file's lines at this tier. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the lines that replace a match at position pos. Context lines come
 * from the file's own matched lines; at tier 2 every other line is
 * re-indented (the leading spaces/tabs of O's first line replaced by those
 * of the file's first matched line).
 */
function buildReplacement(nLines: NLine[], fileLines: string[], pos: number, oLines: string[], tier: number): string[] {
  const out: string[] = [];
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]) : '';
  const p = oLines.length > 0 ? leadingWs(oLines[0]) : '';
  for (const n of nLines) {
    if (n.ctx) {
      out.push(fileLines[pos + n.oIndex]);
    } else {
      let t = n.text;
      if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) {
        t = f + t.slice(p.length);
      }
      out.push(t);
    }
  }
  return out;
}

/** Count occurrences of sub in text, positions allowed to overlap. */
function countOccurrences(text: string, sub: string): number {
  if (sub === '') return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const i = text.indexOf(sub, from);
    if (i === -1) break;
    count++;
    from = i + 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UBodyLine {
  kind: string; // 'ctx' | 'old' | 'new' | 'bs'
  text: string;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
}

interface USection {
  pairOld: string | undefined;
  pairNew: string | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

/** A ---/+++ path: text after the four characters, up to the first tab, trimmed, one leading a/ or b/ removed. */
function parseUnifiedPath(raw: string): string {
  let t = raw;
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/')) t = t.slice(2);
  else if (t.startsWith('b/')) t = t.slice(2);
  return t;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const newSection = (): USection => {
    const s: USection = {
      pairOld: undefined,
      pairNew: undefined,
      renameOld: undefined,
      renameNew: undefined,
      diffOld: undefined,
      diffNew: undefined,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  while (i < n) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      cur = newSection();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = newSection();
        inHeader = true;
      }
      if (cur.pairOld === undefined) cur.pairOld = parseUnifiedPath(lines[i].slice(4));
      if (cur.pairNew === undefined) cur.pairNew = parseUnifiedPath(lines[i + 1].slice(4));
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      if (cur === null) throw new ParseError(i + 1);
      const body: UBodyLine[] = [];
      let j = i + 1;
      while (j < n) {
        const bl = lines[j];
        // A --- line followed by a +++ line ends the body and starts a new section.
        if (bl.startsWith('--- ') && j + 1 < n && lines[j + 1].startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        const c = bl.charAt(0);
        if (c === ' ') {
          body.push({ kind: 'ctx', text: bl.slice(1) });
          j++;
          continue;
        }
        if (c === '-') {
          body.push({ kind: 'old', text: bl.slice(1) });
          j++;
          continue;
        }
        if (c === '+') {
          body.push({ kind: 'new', text: bl.slice(1) });
          j++;
          continue;
        }
        if (c === '\\') {
          body.push({ kind: 'bs', text: bl.slice(1) });
          j++;
          continue;
        }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1];
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: parseInt(m[1], 10), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        throw new ParseError(i + 2);
      }
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => ({ apply: (tree: Map<string, string>, strict: boolean): ApplyResult => applyUnifiedSection(s, tree, strict) }));
}

/** Split a hunk's body into its old lines O and its new lines N (with context marks). */
function deriveHunk(hunk: UHunk): { oLines: string[]; nLines: NLine[] } {
  const oLines: string[] = [];
  const nLines: NLine[] = [];
  for (const b of hunk.body) {
    if (b.kind === 'ctx') {
      oLines.push(b.text);
      nLines.push({ ctx: true, oIndex: oLines.length - 1, text: '' });
    } else if (b.kind === 'old') {
      oLines.push(b.text);
    } else if (b.kind === 'new') {
      nLines.push({ ctx: false, oIndex: -1, text: b.text });
    }
  }
  return { oLines, nLines };
}

/** True when a \ line follows the hunk's last context or + line. */
function bsAfterLastCtxOrPlus(body: UBodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k];
    if (b.kind === 'ctx' || b.kind === 'new') {
      return k + 1 < body.length && body[k + 1].kind === 'bs';
    }
  }
  return false;
}

/** True when a \ line follows the last + line of the whole section. */
function bsAfterLastPlus(hunks: UHunk[]): boolean {
  for (let h = hunks.length - 1; h >= 0; h--) {
    const body = hunks[h].body;
    for (let k = body.length - 1; k >= 0; k--) {
      if (body[k].kind === 'new') {
        return k + 1 < body.length && body[k + 1].kind === 'bs';
      }
    }
  }
  return false;
}

/** Apply a section's hunks in order to a file document, tracking the line drift d. */
function applyHunks(doc: FileDoc, hunks: UHunk[], strict: boolean): { ok: true } | { ok: false; code: string } {
  let d = 0;
  for (const hunk of hunks) {
    const { oLines, nLines } = deriveHunk(hunk);
    if (oLines.length === 0) {
      let pos = hunk.a + d;
      if (pos < 0) pos = 0;
      if (pos > doc.lines.length) pos = doc.lines.length;
      const atEnd = pos === doc.lines.length;
      const rep = nLines.map((x) => x.text);
      doc.lines.splice(pos, 0, ...rep);
      if (atEnd) doc.ends = !bsAfterLastCtxOrPlus(hunk.body);
      d += nLines.length;
    } else {
      const found = findTier(doc.lines, oLines, strict);
      if (found === null) return { ok: false, code: 'no-match' };
      const target = hunk.a - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const atEnd = best + oLines.length === doc.lines.length;
      const rep = buildReplacement(nLines, doc.lines, best, oLines, found.tier);
      doc.lines.splice(best, oLines.length, ...rep);
      if (atEnd) doc.ends = !bsAfterLastCtxOrPlus(hunk.body);
      d += nLines.length - oLines.length;
    }
  }
  return { ok: true };
}

function applyUnifiedSection(sec: USection, tree: Map<string, string>, strict: boolean): ApplyResult {
  const oldRaw = sec.pairOld !== undefined ? sec.pairOld : sec.renameOld !== undefined ? sec.renameOld : sec.diffOld;
  const newRaw = sec.pairNew !== undefined ? sec.pairNew : sec.renameNew !== undefined ? sec.renameNew : sec.diffNew;
  const oldPath = oldRaw === undefined || oldRaw === '/dev/null' ? null : oldRaw;
  const newPath = newRaw === undefined || newRaw === '/dev/null' ? null : newRaw;
  const isCreation = oldPath === null || sec.newFile;
  const isDeletion = newPath === null || sec.deletedFile;
  if (isCreation) {
    if (newPath === null) return fail('unsafe', '');
    if (!isSafePath(newPath)) return fail('unsafe', newPath);
    if (tree.has(newPath)) return fail('exists', newPath);
    const plus: string[] = [];
    for (const h of sec.hunks) {
      for (const b of h.body) {
        if (b.kind === 'new') plus.push(b.text);
      }
    }
    if (plus.length === 0) {
      tree.set(newPath, '');
      return { ok: true };
    }
    const ends = !bsAfterLastPlus(sec.hunks);
    tree.set(newPath, plus.join('\n') + (ends ? '\n' : ''));
    return { ok: true };
  }
  if (isDeletion) {
    if (oldPath === null) return fail('unsafe', '');
    if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
    if (!tree.has(oldPath)) return fail('missing', oldPath);
    tree.delete(oldPath);
    return { ok: true };
  }
  if (oldPath === null || newPath === null) return fail('unsafe', oldPath === null ? '' : oldPath);
  if (!isSafePath(oldPath)) return fail('unsafe', oldPath);
  if (!isSafePath(newPath)) return fail('unsafe', newPath);
  const cur = tree.get(oldPath);
  if (cur === undefined) return fail('missing', oldPath);
  if (oldPath !== newPath && tree.has(newPath)) return fail('exists', newPath);
  const doc = parseFile(cur);
  const r = applyHunks(doc, sec.hunks, strict);
  if (!r.ok) return fail(r.code, oldPath);
  const content = renderFile(doc);
  if (oldPath !== newPath) {
    tree.delete(oldPath);
    tree.set(newPath, content);
    return { ok: true, move: { oldPath, newPath } };
  }
  tree.set(oldPath, content);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function isMarker(line: string, marker: string): boolean {
  return line.replace(/\s+$/, '') === marker;
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (!isMarker(lines[i], '<<<<<<< SEARCH')) {
      i++;
      continue;
    }
    const searchIdx = i;
    let j = i + 1;
    let eqIdx = -1;
    while (j < n) {
      if (isMarker(lines[j], '=======')) {
        eqIdx = j;
        break;
      }
      if (isMarker(lines[j], '<<<<<<< SEARCH') || isMarker(lines[j], '>>>>>>> REPLACE')) throw new ParseError(searchIdx + 1);
      j++;
    }
    if (eqIdx === -1) throw new ParseError(searchIdx + 1);
    let k = eqIdx + 1;
    let repIdx = -1;
    while (k < n) {
      if (isMarker(lines[k], '>>>>>>> REPLACE')) {
        repIdx = k;
        break;
      }
      if (isMarker(lines[k], '<<<<<<< SEARCH')) throw new ParseError(searchIdx + 1);
      k++;
    }
    if (repIdx === -1) throw new ParseError(searchIdx + 1);
    let path: string | null = null;
    for (let p = searchIdx - 1; p > prevReplace; p--) {
      const t = lines[p].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(searchIdx + 1);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevReplace = repIdx;
    i = repIdx + 1;
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    apply(tree: Map<string, string>, strict: boolean): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.has(path)) return fail('exists', path);
        tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return { ok: true };
      }
      const cur = tree.get(path);
      if (cur === undefined) return fail('missing', path);
      const doc = parseFile(cur);
      const found = findTier(doc.lines, oldLines, strict);
      if (found === null) return fail('no-match', path);
      if (found.occ.length > 1) return fail('ambiguous', path);
      const pos = found.occ[0];
      const nLines: NLine[] = newLines.map((t) => ({ ctx: false, oIndex: -1, text: t }));
      const rep = buildReplacement(nLines, doc.lines, pos, oldLines, found.tier);
      doc.lines.splice(pos, oldLines.length, ...rep);
      tree.set(path, renderFile(doc));
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VBodyLine {
  kind: string; // 'ctx' | 'old' | 'new'
  text: string;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: VBodyLine[];
}

interface VLineRef {
  line: string;
  idx: number;
}

function isV4ASectionStart(l: string): boolean {
  return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
}

/** Collect a section's lines, from start up to (not including) the next section start or end. */
function collectV4ASection(lines: string[], start: number, end: number): { content: VLineRef[]; next: number } {
  const content: VLineRef[] = [];
  let j = start;
  while (j < end) {
    const l = lines[j];
    if (isV4ASectionStart(l)) break;
    content.push({ line: l, idx: j });
    j++;
  }
  return { content, next: j };
}

/** Blank lines at the end of a section are not part of it. */
function stripTrailingBlanks(content: VLineRef[]): VLineRef[] {
  let end = content.length;
  while (end > 0 && content[end - 1].line.trim() === '') end--;
  return content.slice(0, end);
}

function parseV4AUpdate(content: VLineRef[], updateLine: number): { moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  let idx = 0;
  if (idx < content.length && content[idx].line.startsWith('*** Move to: ')) {
    moveTo = content[idx].line.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  while (idx < content.length) {
    const ref = content[idx];
    const l = ref.line;
    if (l.startsWith('@@')) {
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
      chunks.push(cur);
      idx++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new ParseError(ref.idx + 1);
      cur.eof = true;
      cur = null;
      idx++;
      continue;
    }
    if (l === '' || l.charAt(0) === ' ' || l.charAt(0) === '-' || l.charAt(0) === '+') {
      if (cur === null) {
        if (chunks.length === 0) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
        } else {
          throw new ParseError(ref.idx + 1);
        }
      }
      if (l === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (l.charAt(0) === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.charAt(0) === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
      else cur.body.push({ kind: 'new', text: l.slice(1) });
      idx++;
      continue;
    }
    throw new ParseError(ref.idx + 1);
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLine + 1);
  return { moveTo, chunks };
}

function parseV4A(lines: string[]): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(n + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let m = /^\*\*\* Add File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1].trim();
      const sec = collectV4ASection(lines, i + 1, last);
      const stripped = stripTrailingBlanks(sec.content);
      const fileLines: string[] = [];
      for (const ref of stripped) {
        const l = ref.line;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new ParseError(ref.idx + 1);
      }
      edits.push(makeV4AAddEdit(path, fileLines));
      i = sec.next;
      continue;
    }
    m = /^\*\*\* Delete File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1].trim();
      const sec = collectV4ASection(lines, i + 1, last);
      const stripped = stripTrailingBlanks(sec.content);
      if (stripped.length > 0) throw new ParseError(stripped[0].idx + 1);
      edits.push(makeV4ADeleteEdit(path));
      i = sec.next;
      continue;
    }
    m = /^\*\*\* Update File: (.*)$/.exec(line);
    if (m !== null) {
      const path = m[1].trim();
      const updateLine = i;
      const sec = collectV4ASection(lines, i + 1, last);
      const stripped = stripTrailingBlanks(sec.content);
      const parsed = parseV4AUpdate(stripped, updateLine);
      edits.push(makeV4AUpdateEdit(path, parsed.moveTo, parsed.chunks));
      i = sec.next;
      continue;
    }
    throw new ParseError(i + 1);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function makeV4AAddEdit(path: string, fileLines: string[]): Edit {
  return {
    apply(tree: Map<string, string>): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      if (tree.has(path)) return fail('exists', path);
      tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return { ok: true };
    },
  };
}

function makeV4ADeleteEdit(path: string): Edit {
  return {
    apply(tree: Map<string, string>): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      if (!tree.has(path)) return fail('missing', path);
      tree.delete(path);
      return { ok: true };
    },
  };
}

function makeV4AUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return {
    apply(tree: Map<string, string>, strict: boolean): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      if (moveTo !== null && !isSafePath(moveTo)) return fail('unsafe', moveTo);
      const cur = tree.get(path);
      if (cur === undefined) return fail('missing', path);
      if (moveTo !== null && tree.has(moveTo)) return fail('exists', moveTo);
      const doc = parseFile(cur);
      let cursor = 0;
      for (const chunk of chunks) {
        const r = applyV4AChunk(doc, chunk, strict, cursor);
        if (!r.ok) return fail(r.code, path);
        cursor = r.cursor;
      }
      const content = renderFile(doc);
      if (moveTo !== null) {
        tree.delete(path);
        tree.set(moveTo, content);
        return { ok: true, move: { oldPath: path, newPath: moveTo } };
      }
      tree.set(path, content);
      return { ok: true };
    },
  };
}

/** Apply one V4A chunk: anchor search, then the first O occurrence at or after the cursor. */
function applyV4AChunk(
  doc: FileDoc,
  chunk: VChunk,
  strict: boolean,
  cursor: number,
): { ok: true; cursor: number } | { ok: false; code: string } {
  if (chunk.anchor !== null) {
    const anchor = chunk.anchor;
    const tiers = strict ? [0] : [0, 1, 2];
    let foundAt: number | null = null;
    for (const t of tiers) {
      for (let i = cursor; i < doc.lines.length; i++) {
        if (lineEq(doc.lines[i], anchor, t)) {
          foundAt = i;
          break;
        }
      }
      if (foundAt !== null) break;
    }
    if (foundAt === null) return { ok: false, code: 'no-match' };
    cursor = foundAt + 1;
  }
  const oLines: string[] = [];
  const nLines: NLine[] = [];
  for (const b of chunk.body) {
    if (b.kind === 'ctx') {
      oLines.push(b.text);
      nLines.push({ ctx: true, oIndex: oLines.length - 1, text: '' });
    } else if (b.kind === 'old') {
      oLines.push(b.text);
    } else {
      nLines.push({ ctx: false, oIndex: -1, text: b.text });
    }
  }
  if (oLines.length === 0) {
    const pos = chunk.eof ? doc.lines.length : cursor;
    const rep = nLines.map((x) => x.text);
    doc.lines.splice(pos, 0, ...rep);
    return { ok: true, cursor: pos + rep.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let hit: { tier: number; pos: number } | null = null;
  for (const t of tiers) {
    const occ = occurrencesAt(doc.lines, oLines, t).filter((p) => p >= cursor);
    const filtered = chunk.eof ? occ.filter((p) => p + oLines.length === doc.lines.length) : occ;
    if (filtered.length > 0) {
      hit = { tier: t, pos: filtered[0] };
      break;
    }
  }
  if (hit === null) return { ok: false, code: 'no-match' };
  const rep = buildReplacement(nLines, doc.lines, hit.pos, oLines, hit.tier);
  doc.lines.splice(hit.pos, oLines.length, ...rep);
  return { ok: true, cursor: hit.pos + rep.length };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validateJsonEdit(v: unknown): Edit | null {
  if (!isPlainObject(v)) return null;
  const path = v['path'];
  const command = v['command'];
  if (typeof path !== 'string') return null;
  if (typeof command !== 'string') return null;
  if (command === 'create') {
    const ft = v['file_text'];
    if (typeof ft !== 'string') return null;
    return makeJsonCreateEdit(path, ft);
  }
  if (command === 'str_replace') {
    const oldStr = v['old_str'];
    if (typeof oldStr !== 'string' || oldStr === '') return null;
    const newStr = v['new_str'];
    if (newStr !== undefined && typeof newStr !== 'string') return null;
    return makeJsonStrReplaceEdit(path, oldStr, newStr === undefined ? '' : newStr);
  }
  if (command === 'insert') {
    const il = v['insert_line'];
    if (typeof il !== 'number' || !Number.isInteger(il)) return null;
    const newStr = v['new_str'];
    if (typeof newStr !== 'string') return null;
    return makeJsonInsertEdit(path, il, newStr);
  }
  return null;
}

function parseJson(patchText: string, lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const firstLine = lines[firstIdx];
  const m = /\S/.exec(firstLine);
  const firstCh = m === null ? '' : firstLine[m.index];
  if (firstCh === '[') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(patchText);
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseError(firstIdx + 1);
    const edits: Edit[] = [];
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (e === null) throw new ParseError(firstIdx + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJsonEdit(parsed);
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function makeJsonCreateEdit(path: string, fileText: string): Edit {
  return {
    apply(tree: Map<string, string>): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      if (tree.has(path)) return fail('exists', path);
      tree.set(path, fileText);
      return { ok: true };
    },
  };
}

function makeJsonStrReplaceEdit(path: string, oldStr: string, newStr: string): Edit {
  return {
    apply(tree: Map<string, string>): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      const cur = tree.get(path);
      if (cur === undefined) return fail('missing', path);
      const doc = parseFile(cur);
      if (doc.br === '\r\n') {
        const text = cur.replace(/\r\n/g, '\n');
        const oldN = oldStr.replace(/\r\n/g, '\n');
        const newN = newStr.replace(/\r\n/g, '\n');
        const n = countOccurrences(text, oldN);
        if (n === 0) return fail('no-match', path);
        if (n > 1) return fail('ambiguous', path);
        const at = text.indexOf(oldN);
        const out = text.slice(0, at) + newN + text.slice(at + oldN.length);
        tree.set(path, out.replace(/\n/g, '\r\n'));
        return { ok: true };
      }
      const n = countOccurrences(cur, oldStr);
      if (n === 0) return fail('no-match', path);
      if (n > 1) return fail('ambiguous', path);
      const at = cur.indexOf(oldStr);
      tree.set(path, cur.slice(0, at) + newStr + cur.slice(at + oldStr.length));
      return { ok: true };
    },
  };
}

function makeJsonInsertEdit(path: string, insertLine: number, newStr: string): Edit {
  return {
    apply(tree: Map<string, string>): ApplyResult {
      if (!isSafePath(path)) return fail('unsafe', path);
      const cur = tree.get(path);
      if (cur === undefined) return fail('missing', path);
      const doc = parseFile(cur);
      if (insertLine < 0 || insertLine > doc.lines.length) return fail('no-match', path);
      const ins = splitPatchLines(newStr);
      doc.lines.splice(insertLine, 0, ...ins);
      tree.set(path, renderFile(doc));
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Format detection (SPEC.md section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (l.trim() !== '') {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== null) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const m = /\S/.exec(firstNonBlank);
    if (m !== null) {
      const c = firstNonBlank[m.index];
      if (c === '[' || c === '{') return 'json';
    }
  }
  for (const l of lines) {
    if (l.replace(/\s+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tree IO and output (SPEC.md sections 2, 3, 10)
// ---------------------------------------------------------------------------

function readTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    const names = readdirSync(dir);
    for (const name of names) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p, prefix + name + '/');
      } else if (st.isFile()) {
        out.set(prefix + name, readFileSync(p, 'utf8'));
      }
    }
  };
  walk(root, '');
  return out;
}

function writeTree(initial: Map<string, string>, tree: Map<string, string>): void {
  const paths = new Set<string>([...initial.keys(), ...tree.keys()]);
  for (const p of paths) {
    const before = initial.get(p);
    const after = tree.get(p);
    if (after === undefined) {
      if (before !== undefined) unlinkSync(p);
    } else if (before !== after) {
      const d = dirname(p);
      if (d !== '.' && d !== '') mkdirSync(d, { recursive: true });
      writeFileSync(p, after, 'utf8');
    }
  }
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Change lines for exit 0: A/D/M from the before/after trees, R replacing D+A pairs of successful moves. */
function computeChangeLines(
  initial: Map<string, string>,
  tree: Map<string, string>,
  moves: { oldPath: string; newPath: string }[],
): string[] {
  const entries: { key: string; line: string }[] = [];
  const paths = new Set<string>([...initial.keys(), ...tree.keys()]);
  for (const p of paths) {
    const before = initial.get(p);
    const after = tree.get(p);
    if (before === undefined && after !== undefined) entries.push({ key: p, line: 'A ' + p });
    else if (before !== undefined && after === undefined) entries.push({ key: p, line: 'D ' + p });
    else if (before !== undefined && after !== undefined && before !== after) entries.push({ key: p, line: 'M ' + p });
  }
  for (const m of moves) {
    if (initial.has(m.oldPath) && !tree.has(m.oldPath) && !initial.has(m.newPath) && tree.has(m.newPath)) {
      for (let k = entries.length - 1; k >= 0; k--) {
        if (entries[k].line === 'D ' + m.oldPath || entries[k].line === 'A ' + m.newPath) entries.splice(k, 1);
      }
      entries.push({ key: m.newPath, line: 'R ' + m.oldPath + ' -> ' + m.newPath });
    }
  }
  entries.sort((a, b) => byteCompare(a.key, b.key));
  return entries.map((e) => e.line);
}

// ---------------------------------------------------------------------------
// Invocation (SPEC.md sections 1, 2)
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  const positionals: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return { code: 2, out: ['error: usage'] };
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return { code: 2, out: ['error: usage'] };
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return { code: 2, out: ['error: usage'] };
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) return { code: 2, out: ['error: usage'] };
        format = v;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positionals.length === 0 ? undefined : positionals[0];
  let patchText: string;
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = splitPatchLines(patchText);
  let fmt = format === null ? 'auto' : format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return { code: 2, out: ['error: format'] };
    fmt = detected;
  }
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4A(lines);
    else edits = parseJson(patchText, lines);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: ['error: parse ' + String(e.line)] };
    throw e;
  }
  const initial = readTree('.');
  const tree = new Map<string, string>(initial);
  const failures: { code: string; path: string }[] = [];
  const moves: { oldPath: string; newPath: string }[] = [];
  for (const edit of edits) {
    const r = edit.apply(tree, strict);
    if (!r.ok) {
      failures.push({ code: r.code, path: r.path });
    } else if (r.move !== undefined) {
      moves.push(r.move);
    }
  }
  if (failures.length > 0) {
    const out: string[] = failures.map((f) => 'error: ' + f.code + ' ' + f.path);
    out.push('failed: ' + String(failures.length) + ' of ' + String(edits.length) + ' edits');
    return { code: 1, out };
  }
  const changeLines = computeChangeLines(initial, tree, moves);
  if (!check) writeTree(initial, tree);
  const out = [...changeLines, 'ok: ' + String(changeLines.length) + (changeLines.length === 1 ? ' file' : ' files')];
  return { code: 0, out };
}

// ---------------------------------------------------------------------------
// Entry point: hand over to the kit's runner inside a trial, else run the CLI.
// ---------------------------------------------------------------------------

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
