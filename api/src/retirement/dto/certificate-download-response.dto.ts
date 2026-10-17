import { ApiProperty } from '@nestjs/swagger';
import type { CertificateDownloadMetadata } from '@shared';

/**
 * Swagger and API DTO representation of certificate download metadata.
 */
export class CertificateDownloadResponseDto implements CertificateDownloadMetadata {
  @ApiProperty({
    description: 'Unique identifier of the certificate or retirement record',
    example: 'RET-0192a83f-4e92-7b2a-9f13-64a8b9f1d2c3',
  })
  id: string;

  @ApiProperty({
    description: 'Filename for the downloaded certificate PDF',
    example: 'retirement-certificate-RET-0192a83f.pdf',
  })
  filename: string;

  @ApiProperty({
    description: 'MIME type of the downloaded certificate file',
    example: 'application/pdf',
  })
  contentType: 'application/pdf';

  @ApiProperty({
    description: 'HTTP Content-Disposition header with attachment directive and filename',
    example: 'attachment; filename="retirement-certificate-RET-0192a83f.pdf"',
  })
  contentDisposition: string;

  @ApiProperty({
    description: 'File size in bytes (when known from buffer length)',
    example: 48210,
    required: false,
  })
  sizeBytes?: number;
}
