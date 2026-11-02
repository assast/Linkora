import { Body, Controller, Delete, Get, Global, Module, Param, ParseUUIDPipe, Patch, Post, Query, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Response } from 'express';
import { Catalog } from './catalog';
import { ContentMutations } from './mutations';
import { Database } from './database';
import { Identity, Public, Viewer } from './auth';
import { BatchDto, BookmarkDto, BookmarkPatchDto, BookmarkQueryDto, CategoryDto, CategoryPatchDto, CategoryReorderDto, PreferencesDto } from './dto';

@Global()
@Module({ providers: [Catalog, ContentMutations], exports: [Catalog, ContentMutations] })
export class ContentModule {}

@Controller('categories')
class CategoriesController {
  constructor(private readonly db: Database, private readonly catalog: Catalog, private readonly mutations: ContentMutations) {}
  @Public() @Get('tree') tree(@Identity() viewer: Viewer) {
    return this.db.read(async tx => this.catalog.categories(tx, await this.catalog.context(tx, viewer)));
  }
  @Post() create(@Identity() viewer: Viewer, @Body() dto: CategoryDto) { return this.mutations.createCategory(viewer.ownerId!, dto); }
  @Post(':id/preview') preview(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryPatchDto) {
    return this.mutations.preview(viewer.ownerId!, { kind: 'category', id, data: dto });
  }
  @Post(':id/reorder') reorder(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryReorderDto) {
    return this.mutations.reorderCategory(viewer.ownerId!, id, dto);
  }
  @Patch(':id') update(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CategoryPatchDto) { return this.mutations.updateCategory(viewer.ownerId!, id, dto); }
  @Delete(':id') remove(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string) { return this.mutations.deleteCategory(viewer.ownerId!, id); }
}
@Module({ controllers: [CategoriesController] })
export class CategoriesModule {}

@Controller('bookmarks')
class BookmarksController {
  constructor(private readonly db: Database, private readonly catalog: Catalog, private readonly mutations: ContentMutations) {}
  @Public() @Get() list(@Identity() viewer: Viewer, @Query() query: BookmarkQueryDto) {
    return this.db.read(async tx => this.catalog.list(tx, await this.catalog.context(tx, viewer), query));
  }
  @Public() @Get(':id') detail(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.read(async tx => this.catalog.book(tx, await this.catalog.context(tx, viewer), id));
  }
  @Post() create(@Identity() viewer: Viewer, @Body() dto: BookmarkDto) { return this.mutations.createBookmark(viewer.ownerId!, dto); }
  @Post(':id/preview') preview(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookmarkPatchDto) {
    return this.mutations.preview(viewer.ownerId!, { kind: 'bookmark', id, data: dto });
  }
  @Patch(':id') update(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BookmarkPatchDto) { return this.mutations.updateBookmark(viewer.ownerId!, id, dto); }
  @Delete(':id') remove(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string) { return this.mutations.deleteBookmark(viewer.ownerId!, id); }
  @Post(':id/visits') async visit(@Identity() viewer: Viewer, @Param('id', ParseUUIDPipe) id: string) {
    await this.db.bookmark.update({ where: { ownerId_id: { ownerId: viewer.ownerId!, id } }, data: { visitCount: { increment: 1 }, lastVisitedAt: new Date() } });
    return { recorded: true };
  }
}
@Module({ controllers: [BookmarksController] })
export class BookmarksModule {}

@Controller('bookmarks')
class BatchController {
  constructor(private readonly mutations: ContentMutations) {}
  @Post('batch/preview') preview(@Identity() viewer: Viewer, @Body() dto: BatchDto) { return this.mutations.preview(viewer.ownerId!, { kind: 'batch', data: dto }); }
  @Post('batch') apply(@Identity() viewer: Viewer, @Body() dto: BatchDto) { return this.mutations.applyBatch(viewer.ownerId!, dto); }
  @Post('export') async export(@Identity() viewer: Viewer, @Body() dto: BatchDto, @Res({ passthrough: true }) response: Response) {
    const data = await this.mutations.export(viewer.ownerId!, dto);
    response.setHeader('Content-Disposition', 'attachment; filename="linkora-bookmarks.json"');
    return data;
  }
}
@Module({ controllers: [BatchController] })
export class BatchModule {}

@Controller()
class HomeController {
  constructor(private readonly db: Database, private readonly catalog: Catalog) {}
  @Public() @Get('home') home(@Identity() viewer: Viewer) {
    return this.db.read(async tx => this.catalog.home(tx, await this.catalog.context(tx, viewer)));
  }
  @Public() @Get('tags') tags(@Identity() viewer: Viewer) {
    return this.db.read(async tx => this.catalog.tags(tx, await this.catalog.context(tx, viewer)));
  }
  @Public() @Get('health') async health() {
    try {
      await this.db.$queryRaw`SELECT 1`;
      const verification = process.env.NODE_ENV === 'test' && new URL(process.env.DATABASE_URL || '').pathname.endsWith('_test');
      return { status: 'ok', ...(verification ? { verification: true } : {}) };
    }
    catch { throw new ServiceUnavailableException('数据库尚未就绪'); }
  }
}
@Module({ controllers: [HomeController] })
export class HomeModule {}

@Controller('preferences')
class PreferencesController {
  constructor(private readonly db: Database) {}
  private fields(value: { theme: string; defaultEngine: string; defaultView: string; expandedCategories: string[];
    bookmarkFontSize: number; categoryFontSize: number; showWorkspace: boolean; workspaceItems: string[] }) {
    return { theme: value.theme, defaultEngine: value.defaultEngine, defaultView: value.defaultView, expandedCategories: value.expandedCategories,
      bookmarkFontSize: value.bookmarkFontSize, categoryFontSize: value.categoryFontSize, showWorkspace: value.showWorkspace, workspaceItems: value.workspaceItems };
  }
  @Get() async get(@Identity() viewer: Viewer) {
    return this.fields(await this.db.userPreferences.upsert({ where: { userId: viewer.ownerId! }, create: { userId: viewer.ownerId! }, update: {} }));
  }
  @Patch() async update(@Identity() viewer: Viewer, @Body() dto: PreferencesDto) {
    return this.fields(await this.db.userPreferences.upsert({ where: { userId: viewer.ownerId! }, create: { userId: viewer.ownerId!, ...dto }, update: dto }));
  }
}
@Module({ controllers: [PreferencesController] })
export class PreferencesModule {}
