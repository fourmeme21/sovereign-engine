import { Request, Response, NextFunction } from 'express';
export interface AuthUser {
    id: string;
    email: string | undefined;
}
declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}
export declare function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void>;
//# sourceMappingURL=authMiddleware.d.ts.map