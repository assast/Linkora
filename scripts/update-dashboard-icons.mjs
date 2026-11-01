import { mkdir, writeFile } from 'node:fs/promises';

const repository = 'homarr-labs/dashboard-icons';
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Linkora icon catalogue updater' };
async function download(url, json = true) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`上游读取失败：${response.status}`);
  return json ? response.json() : response.text();
}
const requested = process.argv[2];
if (requested && !/^[a-f0-9]{40}$/.test(requested)) throw new Error('请指定完整的上游提交哈希');
const commit = requested || (await download(`https://api.github.com/repos/${repository}/commits/main`)).sha;
const tree = await download(`https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`);
if (tree.truncated) throw new Error('上游文件目录不完整，未更新本地索引');
const entries = new Map();
for (const file of tree.tree) {
  const match = /^(png|webp)\/([a-z0-9][a-z0-9-]{0,119})\.(png|webp)$/.exec(file.path);
  if (!match || match[1] !== match[3] || file.type !== 'blob') continue;
  const [, format, id] = match;
  const entry = entries.get(id) || { id, name: id.replaceAll('-', ' '), formats: [] };
  entry.formats.push(format);
  entries.set(id, entry);
}
if (entries.size < 100) throw new Error('上游图标数量异常，未更新本地索引');
const license = await download(`https://raw.githubusercontent.com/${repository}/${commit}/LICENSE`, false);
const directory = new URL('../apps/api/src/resources/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('dashboard-icons.json', directory), JSON.stringify({ repository, commit, license, icons: [...entries.values()].sort((a, b) => a.id.localeCompare(b.id)) }) + '\n');
console.log(`已生成 ${entries.size} 项 Dashboard Icons，固定提交 ${commit}`);
