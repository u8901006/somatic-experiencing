import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';
const HEADERS = { 'User-Agent': 'SEResearchBot/1.0 (research aggregator)' };

const SEARCH_QUERIES = [
  `("Somatic Experiencing"[tiab] OR "Somatic Experiencing therapy"[tiab] OR "body-oriented trauma therapy"[tiab] OR "body-oriented psychotherapy"[tiab] OR "somatic psychotherapy"[tiab] OR "somatic trauma therapy"[tiab])`,
  `("Somatic Experiencing"[tiab] OR "somatic psychotherapy"[tiab]) AND (interoception[tiab] OR interoceptive[tiab] OR proprioception[tiab] OR "body awareness"[tiab] OR autonomic[tiab] OR "heart rate variability"[tiab] OR HRV[tiab] OR "vagal tone"[tiab])`,
  `("Somatic Experiencing"[tiab] OR "somatic therapy"[tiab] OR "body awareness"[tiab]) AND ("Chronic Pain"[mh] OR "chronic pain"[tiab] OR "low back pain"[tiab] OR kinesiophobia[tiab])`,
  `("Stress Disorders, Post-Traumatic"[mh] OR PTSD[tiab]) AND (interoception[tiab] OR "body awareness"[tiab] OR proprioception[tiab]) AND (psychotherapy[tiab] OR intervention[tiab])`,
  `("body-oriented psychotherapy"[tiab] OR "body-oriented trauma therapy"[tiab] OR "somatic psychotherapy"[tiab] OR "bottom-up trauma therapy"[tiab]) AND (trauma[tiab] OR PTSD[tiab])`,
  `("Somatic Experiencing"[tiab] OR "body-oriented trauma therapy"[tiab]) AND ("Stress Disorders, Post-Traumatic"[mh] OR PTSD[tiab] OR "posttraumatic stress"[tiab])`,
  `("Somatic Experiencing"[tiab] OR "body-oriented trauma therapy"[tiab]) AND ("Dissociative Disorders"[mh] OR dissociation[tiab] OR depersonalization[tiab] OR derealization[tiab])`,
  `("Stress Disorders, Post-Traumatic"[mh] OR PTSD[tiab]) AND ("Autonomic Nervous System"[mh] OR "heart rate variability"[tiab] OR HRV[tiab] OR "vagal tone"[tiab]) AND (psychotherapy[tiab] OR therapy[tiab])`,
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: 'papers.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    if (args[i] === '--max-papers' && args[i + 1]) opts.maxPapers = parseInt(args[++i], 10);
    if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function buildDateFilter(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `"${y}/${m}/${dd}"[Date - Publication] : "3000"[Date - Publication]`;
}

function getExistingPmids() {
  const docsDir = resolve(process.cwd(), 'docs');
  if (!existsSync(docsDir)) return new Set();
  const files = readdirSync(docsDir).filter(f => f.startsWith('se-') && f.endsWith('.html'));
  const now = new Date();
  const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pmids = new Set();
  for (const f of files.slice(0, 8)) {
    const dateStr = f.replace('se-', '').replace('.html', '');
    const fileDate = new Date(dateStr);
    if (fileDate < cutoff) continue;
    try {
      const html = readFileSync(join(docsDir, f), 'utf-8');
      const matches = html.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g);
      for (const m of matches) pmids.add(m[1]);
    } catch { /* skip */ }
  }
  return pmids;
}

async function searchPapers(query, retmax = 50) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const url = `${PUBMED_FETCH}?db=pubmed&id=${pmids.join(',')}&retmode=xml`;
  try {
    const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml = await resp.text();
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function getText(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(getText).join(' ');
  if (node && typeof node === 'object') {
    if (node['#text']) return node['#text'];
    const vals = Object.values(node);
    return vals.map(getText).join(' ');
  }
  return '';
}

function parseXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (name) => {
      const arrayNames = ['PubmedArticle', 'AbstractText', 'Keyword', 'Author'];
      return arrayNames.includes(name);
    },
  });
  const parsed = parser.parse(xml);
  const articles = parsed?.PubmedArticleSet?.PubmedArticle || [];
  const papers = [];

  for (const article of articles) {
    try {
      const medline = article.MedlineCitation;
      if (!medline) continue;
      const art = medline.Article;
      if (!art) continue;

      const title = getText(art.ArticleTitle).trim().slice(0, 500);
      const abstractParts = [];
      const abstracts = art.Abstract?.AbstractText;
      if (abstracts) {
        for (const abs of (Array.isArray(abstracts) ? abstracts : [abstracts])) {
          const label = abs?.['@_Label'] || '';
          const text = getText(abs).trim();
          if (label && text) abstractParts.push(`${label}: ${text}`);
          else if (text) abstractParts.push(text);
        }
      }
      const abstract = abstractParts.join(' ').slice(0, 2000);

      const journal = getText(art.Journal?.Title).trim();
      const pubDate = art.Journal?.JournalIssue?.PubDate;
      const dateParts = [];
      if (pubDate) {
        if (pubDate.Year) dateParts.push(String(pubDate.Year));
        if (pubDate.Month) dateParts.push(String(pubDate.Month));
        if (pubDate.Day) dateParts.push(String(pubDate.Day));
      }
      const dateStr = dateParts.join(' ');

      const pmid = String(medline.PMID || '');
      const url = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

      const keywords = [];
      const kwList = medline.KeywordList?.Keyword;
      if (kwList) {
        for (const kw of (Array.isArray(kwList) ? kwList : [kwList])) {
          const t = getText(kw).trim();
          if (t) keywords.push(t);
        }
      }

      papers.push({ pmid, title, journal, date: dateStr, abstract, url, keywords });
    } catch (e) {
      console.error(`[WARN] Failed to parse article: ${e.message}`);
    }
  }
  return papers;
}

async function main() {
  const opts = parseArgs();
  const dateFilter = buildDateFilter(opts.days);
  const existingPmids = getExistingPmids();
  console.error(`[INFO] Found ${existingPmids.size} already-summarized PMIDs from recent reports`);

  const allPmidSet = new Set();
  for (const q of SEARCH_QUERIES) {
    const fullQuery = `${q} AND ${dateFilter}`;
    console.error(`[INFO] Searching: ${q.slice(0, 80)}...`);
    const ids = await searchPapers(fullQuery, opts.maxPapers);
    for (const id of ids) allPmidSet.add(id);
    await new Promise(r => setTimeout(r, 400));
  }

  const newPmids = [...allPmidSet].filter(id => !existingPmids.has(id));
  console.error(`[INFO] Total unique PMIDs: ${allPmidSet.size}, new (not in reports): ${newPmids.length}`);

  if (!newPmids.length) {
    console.error('[INFO] No new papers found');
    const targetDate = process.env.TARGET_DATE || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
    const output = { date: targetDate, count: 0, papers: [] };
    writeFileSync(opts.output, JSON.stringify(output, null, 2));
    console.error(`[INFO] Saved empty result to ${opts.output}`);
    return;
  }

  const papers = await fetchDetails(newPmids.slice(0, opts.maxPapers));
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const targetDate = process.env.TARGET_DATE || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const output = { date: targetDate, count: papers.length, papers };
  writeFileSync(opts.output, JSON.stringify(output, null, 2));
  console.error(`[INFO] Saved ${papers.length} papers to ${opts.output}`);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
