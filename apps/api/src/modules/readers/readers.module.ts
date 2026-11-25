import { Module } from '@nestjs/common';
import { ReaderAuthGuard } from './reader-auth.guard';
import { ReadersController } from './readers.controller';
import { ReadersService } from './readers.service';

@Module({ controllers: [ReadersController], providers: [ReadersService, ReaderAuthGuard], exports: [ReaderAuthGuard] })
export class ReadersModule {}
