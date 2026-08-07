import { createHash } from 'node:crypto';

import { Storage, type Bucket } from '@google-cloud/storage';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  SignUploadOptions,
  SignedUrl,
  StoragePort,
  StoredObject,
} from '../domain/document.ports';

/**
 * ADR-0009's bucket: **one GCS bucket, server-side SDK, signed URLs only.** The
 * Firebase client SDK is not used for storage at all, and no object is ever
 * public — uniform bucket-level access, no ACLs, nothing to misconfigure per
 * object.
 *
 * Signing uses Application Default Credentials, which on GKE resolves through
 * Workload Identity to the `GCS_SIGNER_SA` service account and signs via the IAM
 * `signBlob` API. **No key material is mounted anywhere** — that is why the
 * environment variable is an email rather than a secret.
 */
@Injectable()
export class GcsStorage implements StoragePort {
  private readonly bucket: Bucket;

  constructor(config: ConfigService) {
    const emulator = config.get<string>('STORAGE_EMULATOR_HOST');
    const storage = new Storage({
      projectId: config.get<string>('FIREBASE_PROJECT_ID'),
      // `local` only (environments.md §6.4) — fake-gcs-server in Compose.
      ...(emulator ? { apiEndpoint: emulator } : {}),
    });
    this.bucket = storage.bucket(config.getOrThrow<string>('GCS_BUCKET'));
  }

  /**
   * BR-DOC-002's constrained PUT. `contentType` binds the header the client must
   * send and `x-goog-content-length-range` binds the body size, so two of
   * BR-DOC-005's three layers are enforced by the bucket before a byte of ours
   * is spent. The third is the magic-byte sniff at commit.
   */
  async signUpload(path: string, options: SignUploadOptions): Promise<SignedUrl> {
    const expiresAt = new Date(Date.now() + options.ttlSeconds * 1000);
    const [url] = await this.bucket.file(path).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expiresAt,
      contentType: options.mime,
      extensionHeaders: { 'x-goog-content-length-range': `1,${options.maxBytes}` },
    });
    return { url, expiresAt };
  }

  /**
   * `attachment` disposition for everything that is not an image — ADR-0009's
   * mitigation for the malicious-but-well-formed file: nothing this system
   * stores is ever rendered inline from an origin that holds a session.
   */
  async signDownload(path: string, ttlSeconds: number): Promise<SignedUrl> {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const [url] = await this.bucket.file(path).getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: expiresAt,
    });
    return { url, expiresAt };
  }

  /**
   * BR-DOC-004's four checks in **one pass over the object**: existence, size,
   * the sniff window, and the digest. GCS reports md5 and crc32c and never
   * sha256, so the digest has to be computed — and computing it while the same
   * stream fills the sniff buffer costs one read instead of three.
   *
   * The size is counted rather than read from metadata on purpose: metadata is
   * what the uploader claimed through the resumable protocol, and the point of
   * this step is to stop believing the uploader.
   */
  async inspect(path: string, headBytes: number): Promise<StoredObject | null> {
    const hash = createHash('sha256');
    const head: Buffer[] = [];
    let headLength = 0;
    let sizeBytes = 0;

    try {
      for await (const chunk of this.bucket.file(path).createReadStream()) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        sizeBytes += buffer.length;
        if (headLength < headBytes) {
          const slice = buffer.subarray(0, headBytes - headLength);
          head.push(slice);
          headLength += slice.length;
        }
      }
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }

    return { sizeBytes, head: Buffer.concat(head), sha256: hash.digest('hex') };
  }

  async exists(path: string): Promise<boolean> {
    const [found] = await this.bucket.file(path).exists();
    return found;
  }

  /** Staging → final (BR-DOC-004's last step before the row flips). */
  async move(from: string, to: string): Promise<void> {
    await this.bucket.file(from).move(to);
  }

  async remove(path: string): Promise<void> {
    // Idempotent: an object already gone is a purge that already ran, and
    // BR-DOC-009's object-then-row order means a retry starts here every time.
    await this.bucket.file(path).delete({ ignoreNotFound: true });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 404;
}
