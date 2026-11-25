import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { RulesController } from './rules.controller';
import { RulesService } from './rules.service';

@Module({ imports: [AccessModule], controllers: [RulesController], providers: [RulesService] })
export class RulesModule {}
