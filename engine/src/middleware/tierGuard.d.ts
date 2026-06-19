import { Request, Response, NextFunction } from 'express';
export declare function tierGuard(requiredTier?: 'free' | 'solo' | 'pro' | 'team'): (req: Request, res: Response, next: NextFunction) => Promise<void>;
//# sourceMappingURL=tierGuard.d.ts.map