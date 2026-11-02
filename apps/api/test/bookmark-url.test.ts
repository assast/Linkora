import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSync } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BookmarkDto, BookmarkPatchDto } from '../src/dto';

for (const Dto of [BookmarkDto, BookmarkPatchDto]) {
  const from = (data: object) => plainToInstance<BookmarkPatchDto, object>(Dto, data);
  test(`${Dto.name} 地址2可省略、清空或保存合法地址`, () => {
    for (const [value, expected] of [[undefined, undefined], [null, null], ['', null], ['  ', null], ['  http://bookmark_service.internal:8080/path  ', 'http://bookmark_service.internal:8080/path'], ['https://127.0.0.1:8443/', 'https://127.0.0.1:8443/']] as const) {
      const dto = from({ title: '双地址书签', url: 'https://example.test/', ...(value === undefined ? {} : { url2: value }) });
      assert.deepEqual(validateSync(dto).map(error => error.property), [], String(value));
      assert.equal(Reflect.get(dto, 'url2'), expected);
    }
  });

  test(`${Dto.name} 地址2拒绝非法协议、类型和超长值`, () => {
    for (const url2 of ['javascript:alert(1)', 'file:///tmp/bookmark', 'ftp://example.test/file', 'example.test', 'https://', 'https://example.test/white space', 42, false, [], {}, 'https://example.test/' + 'a'.repeat(4096)]) {
      const dto = from({ title: '双地址书签', url: 'https://example.test/', url2 });
      assert.ok(validateSync(dto).some(error => error.property === 'url2'), JSON.stringify(url2));
    }
  });

  test(`${Dto.name} 两个地址共用4096字符上限`, () => {
    const prefix = 'https://example.test/';
    const url = prefix + 'a'.repeat(4096 - prefix.length);
    const dto = from({ title: '长度边界', url, url2: url });
    assert.deepEqual(validateSync(dto).map(error => error.property), []);
    const tooLong = from({ title: '长度边界', url: url + 'a', url2: url + 'a' });
    assert.deepEqual(validateSync(tooLong).map(error => error.property).sort(), ['url', 'url2']);
  });

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
