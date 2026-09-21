import type { Request, Response, NextFunction } from 'express';
import { sessionStore, type UserSessionData } from '../lib/sessionStore.js';

// Extend Express Request namespace to include session context
declare global {
  namespace Express {
    interface Request {
      session?: UserSessionData;
      sessionId?: string;
    }
  }
}

/**
 * Middleware that validates the httpOnly session cookie against Redis.
 * Populates req.session with the EHR clinical context and access token.
 */
export async function authGuard(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const sid = req.cookies?.sid;

  if (!sid || typeof sid !== 'string') {
    res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Valid session required',
    });
    return;
  }

  try {
    const session = await sessionStore.getSession(sid);

    if (!session) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Session expired or not found',
      });
      return;
    }

    req.session = session;
    req.sessionId = sid;
    next();
  } catch (err: any) {
    console.error('[ERROR] Failed to validate session in authGuard:', err);
    res.status(503).json({
      error: 'SERVICE_UNAVAILABLE',
      message: 'Unable to verify session store',
    });
  }
}
