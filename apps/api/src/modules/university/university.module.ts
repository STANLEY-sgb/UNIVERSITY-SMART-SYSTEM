import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { CampusController } from './campus.controller';
import { ImportsController } from './imports.controller';
import { ExamsController } from './exams.controller';
import { SettingsController } from './settings.controller';
import { UniversityController } from './university.controller';

@Module({ imports: [AccessModule], controllers: [UniversityController, CampusController, ImportsController, ExamsController, SettingsController] })
export class UniversityModule {}
