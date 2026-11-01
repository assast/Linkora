import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DatabaseModule } from './database';
import { AuthModule } from './auth';
import { BatchModule, BookmarksModule, CategoriesModule, ContentModule, HomeModule, PreferencesModule } from './controllers';
import { SiteIconsModule } from './site-icons-controller';
import { IconUploadsModule } from './icon-uploads';
import { configureHttp } from './http';

@Module({ imports: [DatabaseModule, AuthModule, IconUploadsModule, ContentModule, CategoriesModule, BatchModule, BookmarksModule, SiteIconsModule, HomeModule, PreferencesModule] })
export class AppModule {}

export async function createApplication(logger = true) {
  const app = await NestFactory.create(AppModule, { logger: logger ? ['error', 'warn', 'log'] : false });
  configureHttp(app);
  app.enableShutdownHooks();
  return app;
}
