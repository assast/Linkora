import { test } from 'node:test';
import assert from 'node:assert/strict';
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
