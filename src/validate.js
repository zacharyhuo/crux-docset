import { lstat, opendir, readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { load } from 'cheerio';
import { parse as parsePlist } from 'plist';
import { DOMParser } from '@xmldom/xmldom';
import { iconSizes, maximumIconBytes, validateIcon } from './icons.js';

// Resource guards for trusted, already unpacked local v1 bundles. This is not
// an archive sandbox: callers must not mutate the tree during validation.
const MAX_ERRORS = 100;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_ROWS = 2_000_000;
const MAX_ANCHOR_PAGES = 32;
const MAX_ANCHORS = 200_000;
const MAX_CACHE_ANCHORS = 200_000;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function target(value) {
  if (!nonempty(value) || value.length > 8192) throw new Error('unsafe or invalid path');
  const hash = value.indexOf('#');
  const rawPath = hash < 0 ? value : value.slice(0, hash);
  const rawAnchor = hash < 0 ? '' : value.slice(hash + 1);
  const unsafe = path => !path || /^[\/\\]/.test(path) || /[\\\x00-\x1f\x7f?:#]/.test(path) || path.split('/').some(p => p === '..' || p === '.');
  let path;
  let anchor;
  try {
    path = decodeURIComponent(rawPath); // Unlike form decoding, '+' stays '+'.
    anchor = decodeURIComponent(rawAnchor);
    // Reject nested encodings that could conceal traversal downstream, but use
    // exactly one decoding pass for the actual filesystem and anchor lookup.
    let probe = path;
    for (let i = 0; i < 8; i++) {
      if (unsafe(probe)) throw new Error('unsafe path');
      if (!/%[0-9a-f]{2}/i.test(probe)) break;
      probe = decodeURIComponent(probe);
      if (i === 7) throw new Error('unsafe nested encoding');
    }
    if (/[\x00-\x1f\x7f]/.test(anchor)) throw new Error('invalid anchor');
  } catch (error) { throw new Error(`unsafe path or invalid URL encoding: ${value}: ${error.message}`); }
  return { path, anchor };
}

export async function validate(bundle, recipe) {
  const report = { schemaVersion: 1, passed: false, errors: [], warnings: [], pageCount: 0, symbolCount: 0, documentBytes: 0 };
  let errorCount = 0;
  const error = message => { errorCount++; if (report.errors.length < MAX_ERRORS) report.errors.push(String(message).slice(0, 1200)); };
  const finish = () => {
    if (errorCount > MAX_ERRORS) report.errors.push(`${errorCount - MAX_ERRORS} additional validation errors omitted.`);
    report.passed = errorCount === 0;
    return report;
  };
  let root;
  try {
    root = resolve(bundle);
    const stat = await lstat(root);
    if (stat.isSymbolicLink()) throw new Error('bundle is a symlink');
    if (!stat.isDirectory()) throw new Error('bundle must be a directory');
  } catch (e) { error(`Invalid or missing bundle: ${e.message}`); return finish(); }

  // lstat every component, including Contents/Resources/Documents. Never follow
  // even an internal symlink; this also covers dangling links and directory links.
  async function checked(relative, directory = false) {
    const pieces = relative.split('/');
    let current = root;
    for (let i = 0; i < pieces.length; i++) {
      current = join(current, pieces[i]);
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`symlink rejected: ${relative}`);
      if (i < pieces.length - 1 || directory) {
        if (!stat.isDirectory()) throw new Error(`not a directory: ${relative}`);
      } else if (!stat.isFile()) throw new Error(`not a regular file: ${relative}`);
      if (i === pieces.length - 1) return { current, stat };
    }
  }
  const config = recipe?.validation;
  if (!recipe || !nonempty(recipe.identifier) || !nonempty(recipe.bundleName) || !nonempty(recipe.homepage) || !config || typeof config !== 'object' || Array.isArray(config)) {
    error('Invalid recipe: identifier, bundleName, homepage and validation are required.'); return finish();
  }
  for (const key of ['minimumPages', 'minimumSymbols']) {
    if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) error(`Invalid recipe validation.${key}`);
  }
  if (config.requireIcons !== undefined && typeof config.requireIcons !== 'boolean') error('Invalid recipe validation.requireIcons');
  if (config.requireIcons === true) for (const [name, size] of Object.entries(iconSizes)) {
    try {
      const { current, stat } = await checked(name);
      if (stat.size > maximumIconBytes) throw new Error('icon size limit exceeded');
      validateIcon(await readFile(current), size);
    } catch (e) { error(`Icon ${name} validation failed: ${e.message}`); }
  }
  for (const key of ['requiredSymbols', 'requiredPages']) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].length > MAX_FILES)) error(`Invalid recipe validation.${key}`);
  }
  try {
    const { current, stat } = await checked('Contents/Info.plist');
    if (stat.size > 1024 * 1024) throw new Error('plist size limit exceeded');
    let xml = await readFile(current, 'utf8');
    if (/<!ENTITY/i.test(xml)) throw new Error('entity declarations are forbidden');
    // plist's XML parser never fetches resources. Strip only Apple's known
    // declaration, rejecting all other DTDs/internal subsets before parsing.
    xml = xml.replace(/<!DOCTYPE\s+plist\s+PUBLIC\s+["']-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN["']\s+["']https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd["']\s*>/i, '');
    if (/<!DOCTYPE/i.test(xml)) throw new Error('unsupported doctype');
    if (!/<plist\b[^>]*>[\s\S]*<\/plist>\s*$/.test(xml)) throw new Error('malformed plist XML');
    new DOMParser({ onError: (_level, message) => { throw new Error(message); } }).parseFromString(xml, 'text/xml');
    const metadata = parsePlist(xml);
    if (!metadata || metadata.CFBundleIdentifier !== recipe.identifier) throw new Error('identifier mismatch');
  } catch (e) { error(`Info.plist validation failed: ${e.message}`); }

  let entries = 0;
  async function walk(relative) {
    const { current } = await checked(relative, true);
    // Inspect the entire tree that packaging will include, not just Documents.
    // Never follow links; both entry and depth limits apply bundle-wide.
    if (relative.split('/').length > 128) throw new Error('directory depth limit exceeded');
    const items = await opendir(current);
    for await (const item of items) {
      if (++entries > MAX_FILES) throw new Error(`bundle entry count limit exceeded (${MAX_FILES}); page/byte counts are partial`);
      const child = relative ? `${relative}/${item.name}` : item.name;
      try {
        if (item.isSymbolicLink()) throw new Error(`symlink rejected: ${child}`);
        if (item.isDirectory()) { await walk(child); continue; }
        const { stat } = await checked(child);
        // Metadata, icons and other regular extras are checked but are not docs.
        if (!child.startsWith('Contents/Resources/Documents/')) continue;
        report.documentBytes += stat.size;
        if (/^\.x?html?$/i.test(extname(item.name))) {
          report.pageCount++;
          if (stat.size > MAX_PAGE_BYTES) error(`Page size limit exceeded: ${child}`);
        }
      } catch (e) { if (entries > MAX_FILES) throw e; error(`Bundle entry validation failed: ${e.message}`); }
    }
  }
  try { await checked('Contents/Resources/Documents', true); } catch (e) { error(`Documents validation failed: ${e.message}`); }
  try { await walk(''); } catch (e) { error(`Bundle tree validation failed: ${e.message}`); }

  const cache = new Map();
  let cachedAnchors = 0;
  async function page(value, containsText) {
    const { path, anchor } = target(value);
    const { current, stat } = await checked(`Contents/Resources/Documents/${path}`);
    if (stat.size > MAX_PAGE_BYTES) throw new Error(`page size limit exceeded: ${path}`);
    let ids = cache.get(path);
    if ((anchor && !ids) || containsText !== undefined) {
      const $ = load(await readFile(current, 'utf8'));
      if (!ids && anchor) {
        ids = new Set();
        $('[id], a[name]').each((_, element) => {
          for (const value of [$(element).attr('id'), element.tagName === 'a' ? $(element).attr('name') : undefined]) {
            if (value !== undefined) ids.add(value);
            if (ids.size > MAX_ANCHORS) throw new Error(`page anchor count limit exceeded: ${path}`);
          }
        });
        while (cache.size && (cache.size >= MAX_ANCHOR_PAGES || cachedAnchors + ids.size > MAX_CACHE_ANCHORS)) {
          const first = cache.keys().next().value; cachedAnchors -= cache.get(first).size; cache.delete(first);
        }
        cache.set(path, ids); cachedAnchors += ids.size;
      }
      if (containsText !== undefined) {
        if (typeof containsText !== 'string') throw new Error('invalid recipe containsText');
        $('script,style').remove();
        const normalized = $('body').text().replace(/\s+/g, ' ');
        if (!normalized.includes(containsText.replace(/\s+/g, ' '))) throw new Error(`required page text missing: ${path}`);
      }
    }
    if (anchor && !ids.has(anchor)) throw new Error(`missing anchor ${anchor} in ${path}`);
    if (ids) { cache.delete(path); cache.set(path, ids); }
  }
  try { await page(recipe.homepage); } catch (e) { error(`Homepage validation failed: ${e.message}`); }
  if (Array.isArray(config.requiredPages)) for (const item of config.requiredPages.slice(0, MAX_FILES)) {
    try { await page(item?.path, item?.containsText); } catch (e) { error(`Required page validation failed: ${e.message}`); }
  }

  let db;
  try {
    const { current } = await checked('Contents/Resources/docSet.dsidx');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { await lstat(`${current}${suffix}`); }
      catch (e) { if (e.code === 'ENOENT') continue; throw e; }
      throw new Error(`SQLite sidecar rejected: docSet.dsidx${suffix}; bundle must contain a finalized standalone database`);
    }
    db = new DatabaseSync(current, { readOnly: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const integrity = db.prepare('PRAGMA integrity_check(100)').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
    const table = db.prepare("SELECT type, sql FROM sqlite_master WHERE name = 'searchIndex'").get();
    if (table?.type !== 'table' || /^\s*CREATE\s+VIRTUAL/i.test(table.sql ?? '')) throw new Error('SQLite schema requires a regular searchIndex table');
    const columns = db.prepare('PRAGMA table_info(searchIndex)').all();
    if (!['name', 'type', 'path'].every(name => columns.some(column => column.name === name && /^(TEXT|VARCHAR(?:\(\d+\))?)$/i.test(column.type)))) throw new Error('SQLite schema requires name/type/path text columns');
    const count = db.prepare('SELECT COUNT(*) AS count FROM searchIndex').get().count;
    report.symbolCount = Number(count);
    if (!Number.isSafeInteger(report.symbolCount)) throw new Error('symbol count exceeds safe integer limit');
    if (report.symbolCount > MAX_ROWS) error(`Symbol count limit exceeded (${MAX_ROWS}); not all index targets validated`);
    const required = db.prepare('SELECT 1 FROM searchIndex WHERE name = ? COLLATE BINARY LIMIT 1');
    if (Array.isArray(config.requiredSymbols)) for (const symbol of config.requiredSymbols.slice(0, MAX_FILES)) {
      if (!nonempty(symbol)) error('Invalid recipe required symbol');
      else if (!required.get(symbol)) error(`Missing required symbol: ${symbol}`);
    }
    for (const row of db.prepare('SELECT name, type, path FROM searchIndex LIMIT ?').iterate(MAX_ROWS)) {
      if (!nonempty(row.name) || !nonempty(row.type)) error('Invalid index name/type: expected nonempty text');
      try { await page(row.path); } catch (e) { error(`Index target validation failed: ${e.message}`); }
    }
  } catch (e) { error(`SQLite validation failed: ${e.message}`); }
  finally { if (db) { try { db.close(); } catch (e) { error(`SQLite close failed: ${e.message}`); } } }
  if (report.pageCount < config.minimumPages) error(`Page count ${report.pageCount} is below minimum ${config.minimumPages}`);
  if (report.symbolCount < config.minimumSymbols) error(`Symbol count ${report.symbolCount} is below minimum ${config.minimumSymbols}`);
  return finish();
}
