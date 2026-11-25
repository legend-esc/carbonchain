import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

const DEFAULT_MAX_SIZE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MIME_TYPES = [
  'application/pdf',
  'application/geo+json',
  'application/vnd.geo+json',
  'image/png',
  'image/jpeg',
];
const DEFAULT_EXTENSIONS = ['.pdf', '.geojson', '.png', '.jpg', '.jpeg'];

@Component({
  selector: 'app-file-dropzone',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './file-dropzone.component.html',
  styles: [
    `
      .dropzone-wrapper {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
      }

      .dropzone {
        border: 2px dashed #cbd5e1;
        border-radius: 10px;
        padding: 1.75rem 1.25rem;
        text-align: center;
        cursor: pointer;
        background: var(--surface-muted, #f8fafc);
        transition:
          border-color 0.15s ease,
          background-color 0.15s ease;
      }

      .dropzone:hover:not(.dropzone--disabled),
      .dropzone:focus-visible:not(.dropzone--disabled) {
        border-color: #1976d2;
        outline: none;
      }

      .dropzone--dragover {
        border-color: #1976d2;
        background: #eff6ff;
      }

      .dropzone--disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .dropzone__input {
        display: none;
      }

      .dropzone__icon {
        font-size: 1.75rem;
        margin-bottom: 0.4rem;
      }

      .dropzone__title {
        margin: 0 0 0.25rem;
        font-weight: 600;
        font-size: 0.95rem;
      }

      .dropzone__hint {
        margin: 0 0 0.35rem;
        font-size: 0.85rem;
        color: #4b5563;
      }

      .dropzone__browse {
        color: #1976d2;
        font-weight: 600;
        text-decoration: underline;
      }

      .dropzone__constraints {
        margin: 0;
        font-size: 0.75rem;
        color: #6b7280;
      }

      .dropzone__errors {
        margin: 0;
        padding: 0.65rem 1rem 0.65rem 1.75rem;
        border-radius: 6px;
        background: #fee2e2;
        color: #991b1b;
        border: 1px solid #fecaca;
        font-size: 0.825rem;
      }

      .dropzone__files {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
      }

      .dropzone__file {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.75rem;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        background: #ffffff;
        font-size: 0.85rem;
      }

      .dropzone__file-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 500;
      }

      .dropzone__file-size {
        color: #6b7280;
        font-size: 0.78rem;
      }

      .dropzone__remove {
        background: none;
        border: none;
        cursor: pointer;
        color: #6b7280;
        font-size: 0.85rem;
        padding: 0.1rem 0.3rem;
      }
      .dropzone__remove:hover {
        color: #c62828;
      }
    `,
  ],
})
export class FileDropzoneComponent {
  readonly maxSizeBytes = input<number>(DEFAULT_MAX_SIZE_BYTES);
  readonly allowedMimeTypes = input<string[]>(DEFAULT_MIME_TYPES);
  readonly allowedExtensions = input<string[]>(DEFAULT_EXTENSIONS);
  readonly multiple = input<boolean>(false);
  readonly disabled = input<boolean>(false);
  readonly label = input<string>('Upload project documentation');

  readonly filesSelected = output<File[]>();
  readonly fileRemoved = output<File>();
  readonly validationError = output<string>();

  readonly isDragOver = signal(false);
  readonly selectedFiles = signal<File[]>([]);
  readonly errors = signal<string[]>([]);

  readonly maxSizeMb = computed(() => Math.round(this.maxSizeBytes() / (1024 * 1024)));
  readonly acceptAttribute = computed(() =>
    [...this.allowedMimeTypes(), ...this.allowedExtensions()].join(','),
  );

  openFilePicker(inputEl: HTMLInputElement): void {
    if (this.disabled()) return;
    inputEl.click();
  }

  onSpaceKey(event: Event, inputEl: HTMLInputElement): void {
    event.preventDefault();
    this.openFilePicker(inputEl);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (!this.disabled()) {
      this.isDragOver.set(true);
    }
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
    if (this.disabled()) return;
    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFiles(Array.from(files));
    }
  }

  onFileInputChange(event: Event): void {
    const inputEl = event.target as HTMLInputElement;
    const files = inputEl.files;
    if (files && files.length > 0) {
      this.handleFiles(Array.from(files));
    }
    inputEl.value = '';
  }

  removeFile(file: File): void {
    this.selectedFiles.update((list) => list.filter((f) => f !== file));
    this.fileRemoved.emit(file);
    this.filesSelected.emit(this.selectedFiles());
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  private handleFiles(incoming: File[]): void {
    const candidates = this.multiple() ? incoming : [incoming[0]];
    const valid: File[] = [];
    const errs: string[] = [];

    for (const file of candidates) {
      const error = this.validateFile(file);
      if (error) {
        errs.push(error);
        this.validationError.emit(error);
      } else {
        valid.push(file);
      }
    }

    this.errors.set(errs);
    if (valid.length > 0) {
      const next = this.multiple() ? [...this.selectedFiles(), ...valid] : valid;
      this.selectedFiles.set(next);
      this.filesSelected.emit(next);
    }
  }

  private validateFile(file: File): string | null {
    if (file.size > this.maxSizeBytes()) {
      return `File "${file.name}" (${this.formatFileSize(file.size)}) exceeds the ${this.maxSizeMb()} MB limit.`;
    }

    const lowerName = file.name.toLowerCase();
    const hasAllowedExt = this.allowedExtensions().some((ext) =>
      lowerName.endsWith(ext.toLowerCase()),
    );
    const mime = file.type.toLowerCase();
    const allowedMimes = this.allowedMimeTypes().map((m) => m.toLowerCase());

    const isGeoJsonWithGenericMime =
      lowerName.endsWith('.geojson') && (mime === '' || mime === 'application/json');

    const mimeValid =
      mime !== '' ? allowedMimes.includes(mime) || isGeoJsonWithGenericMime : hasAllowedExt;

    if (!mimeValid) {
      return `File "${file.name}" has an unsupported format (${file.type || 'unknown'}). Allowed: PDF, GeoJSON, PNG, JPEG.`;
    }

    return null;
  }
}
