// 千词斩 · 词库预处理脚本（步骤 0）
// 用途：从 kajweb/dict 获取高考/四级/六级三本词书 zip，解析清洗后
//       生成 data/dicts/{gaokao,cet4,cet6}.json 供服务端启动时入库。
// 可重跑：已下载的 zip / 已解压的 JSON 不重复下载；产物全量覆盖写入；
//         解析失败的行计数报告，不静默丢弃、不中断。
// 运行：node scripts/prepare-dicts.mjs

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = join(ROOT, 'data/raw');
const EXTRACT_DIR = join(RAW_DIR, 'extracted');
const OUT_DIR = join(ROOT, 'data/dicts');
const BOOK_REPO = 'https://raw.githubusercontent.com/kajweb/dict/master/book';

// 词书清单：key 为应用内书标识，zip 为 kajweb/dict 仓库 book/ 目录下的文件名
const BOOKS = [
  { key: 'gaokao', id: 'GaoZhong_2', title: '高考英语词汇', zip: '1521164675301_GaoZhong_2.zip' },
  { key: 'cet4',   id: 'CET4_3',     title: '四级英语词汇', zip: '1521164643060_CET4_3.zip' },
  { key: 'cet6',   id: 'CET6_3',     title: '六级英语词汇', zip: '1521164633851_CET6_3.zip' },
];

function ensureZip(book) {
  const zipPath = join(RAW_DIR, book.id + '.zip');
  if (existsSync(zipPath)) return zipPath;
  console.log(`[下载] ${book.id} ← ${BOOK_REPO}/${book.zip}`);
  execFileSync('curl', ['-sSL', '--retry', '3', '-o', zipPath, `${BOOK_REPO}/${book.zip}`], { stdio: 'inherit' });
  return zipPath;
}

function ensureExtractedJson(book, zipPath) {
  const jsonPath = join(EXTRACT_DIR, book.id, book.id + '.json');
  if (existsSync(jsonPath)) return jsonPath;
  mkdirSync(join(EXTRACT_DIR, book.id), { recursive: true });
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', join(EXTRACT_DIR, book.id)]);
  return jsonPath;
}

// 单行记录清洗：解析 JSONL 一行 → 统一字段；失败返回 { error } 并说明原因
function cleanRecord(line) {
  if (!line.trim()) return { error: '空行' };
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return { error: 'JSON 解析失败' };
  }
  const word = String(rec?.headWord ?? '').trim();
  if (!word) return { error: '缺少 headWord' };
  const wc = rec?.content?.word?.content;
  if (!wc) return { error: '缺少 content.word.content' };

  // 释义：取词性 + 中文释义，清洗首尾空白；全空的释义条目剔除
  const trans = (Array.isArray(wc.trans) ? wc.trans : [])
    .map(t => ({ pos: String(t?.pos ?? '').trim(), cn: String(t?.tranCn ?? '').replace(/\s+/g, ' ').trim() }))
    .filter(t => t.cn);
  if (trans.length === 0) return { error: `无有效中文释义` };

  // 例句：取前 2 条中英俱全的
  const sentences = (wc.sentence?.sentences ?? [])
    .filter(s => s?.sContent?.trim() && s?.sCn?.trim())
    .slice(0, 2)
    .map(s => ({ en: s.sContent.trim(), cn: s.sCn.trim() }));

  return {
    word,
    usphone: String(wc.usphone ?? '').trim(),
    ukphone: String(wc.ukphone ?? '').trim(),
    trans,
    sentences,
  };
}

function processBook(book) {
  const zipPath = ensureZip(book);
  const jsonPath = ensureExtractedJson(book, zipPath);

  const lines = readFileSync(jsonPath, 'utf8').split('\n');
  const stats = { raw: 0, ok: 0, dup: 0, bad: 0 };
  const badReasons = {};
  const seen = new Set();
  const words = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    stats.raw++;
    const cleaned = cleanRecord(line);
    if (cleaned.error) {
      stats.bad++;
      badReasons[cleaned.error] = (badReasons[cleaned.error] ?? 0) + 1;
      continue;
    }
    if (seen.has(cleaned.word)) { stats.dup++; continue; } // 同书内重复词，保留首个
    seen.add(cleaned.word);
    words.push(cleaned);
    stats.ok++;
  }

  const out = { book: book.key, title: book.title, total: words.length, words };
  const outPath = join(OUT_DIR, book.key + '.json');
  writeFileSync(outPath, JSON.stringify(out, null, 1));

  console.log(`\n=== ${book.title} (${book.key}) ===`);
  console.log(`原始行数 ${stats.raw}，清洗通过 ${stats.ok}，重复丢弃 ${stats.dup}，坏数据 ${stats.bad}`);
  if (stats.bad > 0) {
    for (const [reason, n] of Object.entries(badReasons)) console.log(`  坏数据 [${reason}] × ${n}`);
  }
  console.log(`输出 ${outPath}，共 ${out.total} 词`);
  console.log('样例（前 3 词）:');
  for (const w of words.slice(0, 3)) console.log('  ' + JSON.stringify(w));
  return stats;
}

// ---- 主流程 ----
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

const totals = {};
for (const book of BOOKS) {
  totals[book.key] = processBook(book);
}

console.log('\n=== 汇总 ===');
for (const [key, s] of Object.entries(totals)) {
  console.log(`${key}: ${s.ok} 词（坏数据 ${s.bad}，重复 ${s.dup}）`);
}
const totalBad = Object.values(totals).reduce((a, s) => a + s.bad, 0);
console.log(totalBad === 0 ? '全部数据清洗通过，无坏数据。' : `注意：共有 ${totalBad} 条坏数据被剔除（见上方明细）。`);
