import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { imageMetadata } from '../scripts/image-tags.mjs';

const sha = 'a'.repeat(40);
test('主分支发布提交和 latest 标签，前后端指向相同提交', () => {
  for (const component of ['web', 'api']) {
    const value = imageMetadata('Owner/Linkora', 'refs/heads/main', sha, component);
    assert.deepEqual(value.tags, [`ghcr.io/owner/linkora-${component}:sha-${sha}`, `ghcr.io/owner/linkora-${component}:latest`]);
    assert.equal(value.sha, sha);
  }
});
test('稳定发布生成版本和 latest 标签', () => {
  const value = imageMetadata('Owner/Linkora', 'refs/tags/v0.1.0', sha, 'api');
  assert.deepEqual(value.tags.slice(1), ['ghcr.io/owner/linkora-api:v0.1.0', 'ghcr.io/owner/linkora-api:latest']);
});
test('拉取请求、其他分支和不合法标签不能发布', () => {
  for (const ref of ['refs/pull/1/merge', 'refs/heads/feature', 'refs/tags/v0.1.0-beta', 'refs/tags/v01.1.0', 'refs/tags/v1.0.0;echo']) {
    assert.throws(() => imageMetadata('Owner/Linkora', ref, sha, 'web'));
  }
});

test('API 图标缓存目录由 node 用户写入专用卷且不公开静态访问', async () => {
  const [dockerfile, compose, nginx, app] = await Promise.all([
    readFile(new URL('../deploy/Dockerfile.api', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/nginx.conf', import.meta.url), 'utf8'),
    readFile(new URL('../apps/api/src/app.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(dockerfile, /mkdir -p \/app\/data\/site-icons \/app\/data\/icon-uploads && chown -R node:node \/app\/data\/site-icons \/app\/data\/icon-uploads/);
  assert.match(dockerfile, /USER node/);
  assert.match(compose, /ICON_CACHE_DIR: \$\{ICON_CACHE_DIR:-\/app\/data\/site-icons\}/);
  assert.match(compose, /site_icons:\$\{ICON_CACHE_DIR:-\/app\/data\/site-icons\}/);
  assert.match(compose, /icon_uploads:\$\{ICON_UPLOAD_DIR:-\/app\/data\/icon-uploads\}/);
  assert.match(nginx, /client_max_body_size 3m/);
  assert.match(nginx, /proxy_no_cache 1/);
  assert.match(nginx, /Cache-Control "no-store" always/);
  assert.doesNotMatch(nginx, /site-icons|\/app\/data/);
  assert.doesNotMatch(app, /ServeStaticModule/);
});
