import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * Role-based access guard.
 *
 * Resolves the required roles from the `roles` metadata set via
 * `SetMetadata('roles', [...])` (or the `@Roles()` decorator) and allows
 * the request only when the authenticated user's `role` claim matches one
 * of them.  When no roles metadata is present the request is allowed.
 *
 * Fail-closed: if there is no authenticated user, access is denied.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles =
      this.reflector.get<string[]>('roles', context.getHandler()) ?? [];

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user as { role?: string } | undefined;

    if (!user?.role) {
      throw new ForbiddenException('Authenticated user required');
    }

    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException('Insufficient role');
    }

    return true;
  }
}
