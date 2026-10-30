import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function imageMetadata(repository, ref, sha, component) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) || !['web', 'api'].includes(component)) throw new Error('镜像元数据无效');
  const image = `ghcr.io/${repository.toLowerCase()}-${component}`;
  const tags = [`${image}:sha-${sha}`];
  if (ref.startsWith('refs/tags/')) {
    const version = ref.slice('refs/tags/'.length);
    if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('发布标签必须为稳定版本 vX.Y.Z');
    tags.push(`${image}:${version}`, `${image}:latest`);
  } else if (ref !== 'refs/heads/main') throw new Error('此引用不能发布镜像');
  return { image, tags, sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = imageMetadata(process.env.GITHUB_REPOSITORY || '', process.env.GITHUB_REF || '', process.env.GITHUB_SHA || '', process.argv[2]);
  if (process.env.GITHUB_OUTPUT) {
    const delimiter = 'TAGS_' + randomBytes(8).toString('hex');
    appendFileSync(process.env.GITHUB_OUTPUT, `image=${result.image}\ntags<<${delimiter}\n${result.tags.join('\n')}\n${delimiter}\n`);
  }
  console.log(JSON.stringify(result));
}
