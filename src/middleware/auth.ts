import { Context, NextFunction } from "grammy";
import { logger } from "../utils/logger.js";

export function authMiddleware(allowedUserIds: number[]) {
  return (ctx: Context, next: NextFunction) => {
    const userId = ctx.from?.id;
    if (!userId || !allowedUserIds.includes(userId)) {
      logger.debug({ userId }, "Unauthorized access attempt");
      return; // silently drop
    }
    return next();
  };
}
