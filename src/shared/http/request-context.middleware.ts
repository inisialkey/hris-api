import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';

import { runInContextScope, setRequestContext } from '../context';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Chain position 1 (backend-nestjs §5): assign or honour `X-Request-Id`, echo it
 * on every response, and open the context scope everything downstream writes to.
 *
 * The header rides success responses too, not only errors — ADR-0007 — so a
 * support conversation about a request that *worked* has the same handle as one
 * about a request that did not.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const supplied = req.header(REQUEST_ID_HEADER);
    const requestId = supplied && supplied.length <= 128 ? supplied : uuidv7();
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runInContextScope({}, () => {
      setRequestContext({ requestId });
      next();
    });
  }
}
