import { Module } from '@nestjs/common';
import { BiometricsModule } from '../biometrics/biometrics.module';
import { ReadersModule } from '../readers/readers.module';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { TapService } from './tap.service';
import { EligibilityService } from './eligibility.service';
import { OfflineService } from './offline.service';
import { FactsService } from './facts.service';
import { WorkflowsService } from './workflows.service';
import { OverridesController } from './overrides.controller';

@Module({
  imports: [ReadersModule, BiometricsModule],
  controllers: [AccessController, OverridesController],
  providers: [AccessService, TapService, FactsService, EligibilityService, OfflineService, WorkflowsService],
  exports: [FactsService, EligibilityService],
})
export class AccessModule {}
