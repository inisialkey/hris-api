import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { KEY_PROVIDER } from './key-provider.port';
import { LocalKeyProvider } from './local-key-provider';
import { TenantKeyService } from './tenant-key.service';

/**
 * ADR-0016's crypto helpers, wired.
 *
 * Global because the `encryptedText` column type is reachable from any schema
 * file and its precondition — loaded key material — must be satisfiable from
 * any module that owns an encrypted column. Today that is employee alone;
 * recruitment's candidate fields and system-administration's `totp_secret` are
 * both already specified as `encryptedText` (ADR-0017 decision 3), so the
 * binding is shared before its second consumer rather than after.
 *
 * The provider is chosen by environment: `LocalKeyProvider` refuses to load
 * outside `local` and `test`, so wiring it unconditionally would fail boot in
 * staging — which is why the factory is the seam and a Cloud KMS provider is
 * one branch here plus one class.
 */
@Global()
@Module({
  providers: [
    {
      provide: KEY_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new LocalKeyProvider(config),
    },
    TenantKeyService,
  ],
  exports: [KEY_PROVIDER, TenantKeyService],
})
export class CryptoModule {}
