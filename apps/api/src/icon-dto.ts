import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import { ApiProperty, IntersectionType } from '@nestjs/swagger';
import { ICONIFY_ID_PATTERN } from './iconify-icons';

export class IconVersionDto {
  @ApiProperty({ nullable: true, type: String }) @Transform(({ value }) => value === 'null' ? null : value)
  @ValidateIf((_, value) => value !== null) @IsUUID() expectedVersion!: string | null;
}

export class IconConfigDto extends IconVersionDto {
  @ApiProperty({ enum: ['auto', 'dashboard', 'iconify'] }) @IsIn(['auto', 'dashboard', 'iconify']) source!: 'auto' | 'dashboard' | 'iconify';
  @ApiProperty({ required: false }) @ValidateIf((object: IconConfigDto, value) => object.source === 'dashboard' || value !== undefined)
  @IsString() @Matches(/^[a-z0-9][a-z0-9-]{0,119}$/) dashboardId?: string;
  @ApiProperty({ required: false }) @ValidateIf((object: IconConfigDto, value) => object.source === 'iconify' || value !== undefined)
  @IsString() @MaxLength(160) @Matches(ICONIFY_ID_PATTERN) iconifyId?: string;
}

export class IconPageDto {
  @ApiProperty({ required: false, default: 1 }) @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiProperty({ required: false, default: 24 }) @Type(() => Number) @IsInt() @Min(1) @Max(60) pageSize = 24;
}

export class IconLibrarySourceDto {
  @ApiProperty({ required: false, enum: ['dashboard', 'iconify'], default: 'dashboard' }) @IsIn(['dashboard', 'iconify']) source: 'dashboard' | 'iconify' = 'dashboard';
}

export class IconLibraryQueryDto extends IntersectionType(IconPageDto, IconLibrarySourceDto) {
  @ApiProperty({ required: false, default: '' }) @IsString() @MaxLength(100) keyword = '';
}

export class IconRefreshDto {
  @ApiProperty({ enum: ['selected', 'all'] }) @IsIn(['selected', 'all']) scope!: 'selected' | 'all';
  @ApiProperty({ required: false, type: [String] }) @Transform(({ value }) => Array.isArray(value) ? [...new Set(value)] : value)
  @ValidateIf((object: IconRefreshDto, value) => object.scope === 'selected' || value !== undefined)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID(undefined, { each: true }) bookmarkIds?: string[];
}
