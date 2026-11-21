import {
  Body,
  Controller,
  Patch,
  Request,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  NotificationsService,
  NotificationPreferences,
} from '../common/notifications.service';

/**
 * UsersController
 *
 * Exposes user-scoped endpoints.  Currently provides notification-preference
 * management; additional user-profile endpoints can be added here.
 */
@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * PATCH /users/notifications/preferences
   *
   * Update the calling user's notification opt-in preferences.
   * Returns the full updated preference object.
   *
   * The caller's Stellar address is extracted from the JWT `sub` claim.
   */
  @ApiOperation({
    summary: 'Update notification preferences for the authenticated user',
  })
  @ApiResponse({
    status: 200,
    description: 'Updated notification preferences',
  })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseGuards(JwtAuthGuard)
  @Patch('notifications/preferences')
  updateNotificationPreferences(
    @Body() body: Partial<NotificationPreferences>,
    @Request() req: { user: { sub: string } },
  ): NotificationPreferences {
    const address = req.user.sub;
    return this.notificationsService.updatePreferences(address, body);
  }
}
