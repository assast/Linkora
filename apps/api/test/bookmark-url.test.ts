import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSync } from 'class-validator';
import { BookmarkDto, BookmarkPatchDto } from '../src/dto';

for (const Dto of [BookmarkDto, BookmarkPatchDto]) {
  test(`${Dto.name} 接受带下划线的内网 HTTP/HTTPS 主机名`, () => {
    for (const url of ['http://bookmark_service.internal:18081/path', 'https://internal_service/', 'http://127.0.0.1:8080/']) {
      const errors = validateSync(Object.assign(new Dto(), { title: '迁移书签', url }));
      assert.deepEqual(errors.map(error => error.property), [], url);
    }
  });

  test(`${Dto.name} 继续拒绝非 HTTP/HTTPS 或无效地址`, () => {
    for (const url of ['javascript:alert(1)', 'file:///tmp/bookmark', 'ftp://example.test/file', 'https://', 'https://example.test/white space']) {
      const errors = validateSync(Object.assign(new Dto(), { title: '迁移书签', url }));
      assert.ok(errors.some(error => error.property === 'url'), url);
    }
  });
}
