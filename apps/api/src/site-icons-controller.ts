import { BadRequestException, Body, Controller, Get, HttpCode, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiProduces, ApiResponse } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AuthModule, Identity, Public, type Viewer } from './auth';
import { Catalog } from './catalog';
import { AppConfig } from './config';
import { Database } from './database';
import { bookmarkOrigin, SiteIconService, type CachedIcon } from './site-icons';
import { BookmarkIcons } from './bookmark-icons';
import { DashboardIcons } from './dashboard-icons';
import { IconWorkQueue } from './icon-work';
import { IconRefreshJobs } from './icon-refresh';
import { ICON_UPLOAD_MAX_BYTES, type IconUpload } from './icon-uploads';
import { IconConfigDto, IconLibraryQueryDto, IconPageDto, IconRefreshDto, IconVersionDto } from './icon-dto';

function imageResponse(response: Response, icon: CachedIcon | null) {
  if (!icon) { response.status(204); return undefined; }
  response.setHeader('Content-Type', icon.mediaType);
  response.setHeader('Content-Length', icon.bytes.length);
  return new StreamableFile(icon.bytes);
}

function iconRequest(request: Request, response: Response) {
  const controller = new AbortController();
  const onAborted = () => controller.abort('client-aborted');
  const onClosed = () => { if (!response.writableEnded) onAborted(); };
  request.once('aborted', onAborted); response.once('close', onClosed);
  if (request.aborted || response.destroyed) onAborted();
  const timer = setTimeout(() => controller.abort('budget'), 10_000);
  return { signal: controller.signal, dispose() {
    clearTimeout(timer); request.removeListener('aborted', onAborted); response.removeListener('close', onClosed);
  } };
}

@Controller('bookmarks')
export class SiteIconsController {
  constructor(private readonly db: Database, private readonly catalog: Catalog, private readonly icons: SiteIconService, private readonly saved: BookmarkIcons) {}

  @Get(':id/icon-config') @ApiOperation({ summary: '读取书签图标配置' })
  config(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string) { return this.saved.config(viewer.ownerId!, id); }

  @Patch(':id/icon-config') @ApiOperation({ summary: '选择图标库条目或恢复自动图标' })
  select(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IconConfigDto) { return this.saved.select(viewer.ownerId!, id, dto); }

  @Post(':id/icon-upload') @ApiOperation({ summary: '上传并应用书签图标' }) @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file', 'expectedVersion'], properties: {
    file: { type: 'string', format: 'binary' }, expectedVersion: { type: 'string', description: '当前版本 UUID；首次为字符串 null' },
  } } })
  @ApiResponse({ status: 413, description: '上传图片超过 2 MiB。' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: ICON_UPLOAD_MAX_BYTES, files: 1, fields: 1, fieldSize: 128, parts: 2 } }))
  upload(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IconVersionDto, @UploadedFile() file?: IconUpload) {
    if (!file) throw new BadRequestException('请选择图标图片');
    return this.saved.upload(viewer.ownerId!, id, dto.expectedVersion, file);
  }

  private async visibleBook(viewer: Viewer, id: string) {
    try {
      return await this.db.read(async tx => this.catalog.book(tx, await this.catalog.context(tx, viewer), id));
    } catch (error) {
      if (error instanceof NotFoundException) return null;
      throw error;
    }
  }

  @Public() @Get(':id/icon')
  @ApiOperation({ summary: '读取已保存书签的站点图标' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('image/png', 'image/jpeg', 'image/webp', 'image/x-icon')
  @ApiResponse({ status: 200, description: '已校验的网站图标图片。', content: {
    'image/png': { schema: { type: 'string', format: 'binary' } },
    'image/jpeg': { schema: { type: 'string', format: 'binary' } },
    'image/webp': { schema: { type: 'string', format: 'binary' } },
    'image/x-icon': { schema: { type: 'string', format: 'binary' } },
  } })
  @ApiResponse({ status: 204, description: '当前没有可用图标；响应不含内容。' })
  @ApiResponse({ status: 404, description: '书签不存在或当前身份不可见；响应不含内容。' })
  async icon(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const book = await this.visibleBook(viewer, id);
    if (!book) { response.status(404); return undefined; }
    const origin = bookmarkOrigin(book.url);
    if (!origin) { response.status(204); return undefined; }
    const config = await this.saved.readConfig(id);

    const fetch = iconRequest(request, response);
    let icon;
    try {
      icon = config && await this.saved.image(config, fetch.signal);
      if (!icon) icon = await this.icons.getForBookmark(book.url, fetch.signal);
    } finally { fetch.dispose(); }

    if (!icon) { response.status(204); return undefined; }
    const current = await this.visibleBook(viewer, id);
    if (!current) { response.status(404); return undefined; }
    const currentConfig = await this.saved.readConfig(id);
    if (bookmarkOrigin(current.url) !== origin || (currentConfig?.version || null) !== (config?.version || null)) { response.status(204); return undefined; }
    return imageResponse(response, icon);
  }
}

@Controller('icon-library')
class IconLibraryController {
  constructor(private readonly library: DashboardIcons) {}
  @Get() @ApiOperation({ summary: '搜索 Dashboard Icons 本地目录' })
  search(@Query() query: IconLibraryQueryDto) { return this.library.search(query.keyword, query.page, query.pageSize); }
  @Get(':id/preview') @ApiOperation({ summary: '读取图标库同源预览' }) @ApiProduces('image/png', 'image/webp')
  async preview(@Param('id') id: string, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    if (!this.library.entry(id)) throw new NotFoundException('图标不存在');
    const fetch = iconRequest(request, response);
    try { return imageResponse(response, (await this.library.select(id, fetch.signal))?.icon || null); }
    finally { fetch.dispose(); }
  }
}

@Controller('icon-refresh-jobs')
class IconRefreshController {
  constructor(private readonly jobs: IconRefreshJobs) {}
  @Post() @HttpCode(202) @ApiOperation({ summary: '刷新选中或全库自动图标' })
  create(@Identity() viewer: Viewer, @Body() dto: IconRefreshDto) { return this.jobs.create(viewer.ownerId!, dto); }
  @Get(':id') @ApiOperation({ summary: '读取自动图标刷新进度与分页结果' })
  get(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Query() query: IconPageDto) { return this.jobs.get(viewer.ownerId!, id, query.page, query.pageSize); }
}

@Module({
  imports: [AuthModule],
  controllers: [SiteIconsController, IconLibraryController, IconRefreshController],
  providers: [IconWorkQueue, BookmarkIcons, IconRefreshJobs,
    { provide: SiteIconService, useFactory: (config: AppConfig, queue: IconWorkQueue) => new SiteIconService(config.iconCacheDir, undefined, undefined, undefined, queue), inject: [AppConfig, IconWorkQueue] },
    { provide: DashboardIcons, useFactory: (config: AppConfig, queue: IconWorkQueue) => new DashboardIcons(config.iconCacheDir, queue), inject: [AppConfig, IconWorkQueue] }],
})
export class SiteIconsModule {}
