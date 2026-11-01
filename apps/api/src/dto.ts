import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsString, IsUUID, IsUrl, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested } from 'class-validator';
import { ApiProperty, IntersectionType, PartialType } from '@nestjs/swagger';

const optional = (_: unknown, value: unknown) => value !== undefined;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
const queryBoolean = ({ value }: { value: unknown }) => value === 'true' ? true : value === 'false' ? false : value;

export function normalizeTags(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const unique = new Map<unknown, unknown>();
  for (const item of value) {
    const clean = typeof item === 'string' ? item.trim() : item;
    if (clean === '') continue;
    const key = typeof clean === 'string' ? clean.toLocaleLowerCase() : clean;
    if (!unique.has(key)) unique.set(key, clean);
  }
  return [...unique.values()];
}

export class LoginDto {
  @ApiProperty() @Transform(({ value }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @MinLength(8) @MaxLength(1024) password!: string;
  @ApiProperty({ required: false, nullable: true, minimum: 1, maximum: 3650 })
  @Type(() => Number) @ValidateIf((_, value) => value !== undefined && value !== null) @IsInt() @Min(1) @Max(3650) sessionDays?: number | null;
}

export class ConfirmationDto {
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsInt() @Min(0) expectedRevision?: number;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() confirmedPublic?: boolean;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() confirmedDelete?: boolean;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() confirmedPrivateExport?: boolean;
}

export class CategoryDto {
  @ApiProperty({ maxLength: 40 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(40) name!: string;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== undefined && v !== null) @IsUUID() parentId?: string | null;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() isPrivate?: boolean;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsInt() sortOrder?: number;
}
export class CategoryPatchDto extends IntersectionType(PartialType(CategoryDto, { skipNullProperties: false }), ConfirmationDto) {}

export class CategoryReorderDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() targetId!: string;
  @ApiProperty({ enum: ['before', 'after'] }) @IsIn(['before', 'after']) position!: 'before' | 'after';
}

export class BookmarkDto {
  @ApiProperty({ maxLength: 200 }) @Transform(trim) @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @ApiProperty({ maxLength: 4096 }) @Transform(trim) @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false, allow_underscores: true }) @MaxLength(4096) url!: string;
  @ApiProperty({ required: false, nullable: true }) @ValidateIf((_, v) => v !== undefined && v !== null) @IsUUID() categoryId?: string | null;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsString() @MaxLength(1000) description?: string;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsString() @MaxLength(10000) notes?: string;
  @ApiProperty({ required: false, type: [String] }) @ValidateIf(optional) @Transform(({ value }) => normalizeTags(value))
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() isPrivate?: boolean;
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() isFavorite?: boolean;
}
export class BookmarkPatchDto extends IntersectionType(PartialType(BookmarkDto, { skipNullProperties: false }), ConfirmationDto) {}

export class BookmarkQueryDto {
  @ApiProperty({ required: false, format: 'uuid' })
  @ValidateIf(optional) @IsUUID() categoryId?: string;
  @ApiProperty({ required: false, default: true })
  @Transform(queryBoolean) @IsBoolean() includeDescendants = true;
  @ApiProperty({ required: false, default: '', maxLength: 500 })
  @Transform(trim) @IsString() @MaxLength(500) keyword = '';
  @ApiProperty({ required: false, type: [String] })
  @Transform(({ value }) => Array.isArray(value) ? [...new Set(value)] : typeof value === 'string' ? value.split(',') : value)
  @IsArray() @ArrayMaxSize(20) @IsUUID(undefined, { each: true }) tagIds: string[] = [];
  @ApiProperty({ required: false }) @ValidateIf(optional) @Transform(queryBoolean) @IsBoolean() favorite?: boolean;
  @ApiProperty({ required: false, enum: ['all', 'private', 'public'], default: 'all' })
  @IsIn(['all', 'private', 'public']) privacy: 'all' | 'private' | 'public' = 'all';
  @ApiProperty({ required: false, enum: ['newest', 'oldest', 'title', 'frequent'], default: 'newest' })
  @IsIn(['newest', 'oldest', 'title', 'frequent']) sort: 'newest' | 'oldest' | 'title' | 'frequent' = 'newest';
  @ApiProperty({ required: false, minimum: 1, default: 1 }) @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiProperty({ required: false, minimum: 1, maximum: 100, default: 50 }) @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 50;
}

export const operations = ['MOVE_CATEGORY', 'ADD_TAGS', 'REMOVE_TAGS', 'REPLACE_TAGS', 'SET_FAVORITE', 'SET_PRIVACY', 'DELETE', 'EXPORT'] as const;
export type Operation = typeof operations[number];

export class BatchPayloadDto {
  @ApiProperty({ required: false, nullable: true, format: 'uuid' })
  @ValidateIf((_, v) => v !== undefined && v !== null) @IsUUID() categoryId?: string | null;
  @ApiProperty({ required: false, type: [String] }) @ValidateIf(optional) @Transform(({ value }) => normalizeTags(value)) @IsArray() @ArrayMaxSize(20)
  @IsString({ each: true }) @MaxLength(40, { each: true }) tags?: string[];
  @ApiProperty({ required: false }) @ValidateIf(optional) @IsBoolean() value?: boolean;
}
export class BatchDto extends ConfirmationDto {
  @ApiProperty({ enum: operations }) @IsIn(operations) operation!: Operation;
  @ApiProperty({ type: [String] }) @Transform(({ value }) => Array.isArray(value) ? [...new Set(value)] : value)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) bookmarkIds!: string[];
  @ApiProperty({ required: false, type: BatchPayloadDto }) @Type(() => BatchPayloadDto) @ValidateNested() payload: BatchPayloadDto = new BatchPayloadDto();
}

export class PreferencesDto {
  @ApiProperty({ required: false, enum: ['light', 'dark'] }) @ValidateIf(optional) @IsIn(['light', 'dark']) theme?: 'light' | 'dark';
  @ApiProperty({ required: false, enum: ['google', 'bing', 'baidu', 'duck', 'github'] }) @ValidateIf(optional) @IsIn(['google', 'bing', 'baidu', 'duck', 'github']) defaultEngine?: string;
  @ApiProperty({ required: false, enum: ['list', 'grid'] }) @ValidateIf(optional) @IsIn(['list', 'grid']) defaultView?: 'list' | 'grid';
  @ApiProperty({ required: false, type: [String] }) @ValidateIf(optional) @IsArray() @ArrayMaxSize(5000) @IsUUID(undefined, { each: true }) expandedCategories?: string[];
}
