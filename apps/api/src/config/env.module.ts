import { DynamicModule, Global, Module } from '@nestjs/common';
import { ENV, Env, loadEnv } from './env';

@Global()
@Module({})
export class EnvModule {
  static forRoot(env: Env = loadEnv()): DynamicModule {
    return { module: EnvModule, providers: [{ provide: ENV, useValue: env }], exports: [ENV] };
  }
}
