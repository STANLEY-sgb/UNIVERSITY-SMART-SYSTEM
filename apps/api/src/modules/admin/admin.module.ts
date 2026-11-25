import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AdminController } from './admin.controller';
import { ReportsController } from './reports.controller';
import { DomainReportsController } from './domain-reports.controller';

@Module({ imports: [AccessModule], controllers: [AdminController, ReportsController, DomainReportsController] })
export class AdminModule {}
