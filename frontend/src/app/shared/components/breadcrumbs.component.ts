import { CommonModule, DOCUMENT } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ActivatedRouteSnapshot, NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';

export interface BreadcrumbItem {
  label: string;
  url: string;
  isCurrent: boolean;
}

const SEGMENT_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  portfolio: 'Portfolio',
  marketplace: 'Marketplace',
  retire: 'Retire',
  credits: 'Credits',
  projects: 'Projects',
  admin: 'Admin',
  certificates: 'Certificates',
  verifier: 'Verifier',
  apply: 'Apply',
  status: 'Status',
  'connect-wallet': 'Connect Wallet',
  offline: 'Offline',
  seller: 'Seller Dashboard',
};

const JSONLD_SCRIPT_ID = 'cc-breadcrumb-jsonld';

/**
 * Issue #1358 — Dynamic breadcrumb navigation component with deep-linking
 * support across all routes and schema.org `BreadcrumbList` metadata
 * (both HTML microdata and JSON-LD).
 */
@Component({
  selector: 'app-breadcrumbs',
  standalone: true,
  imports: [CommonModule, RouterLink],
  template: `
    @if (breadcrumbs().length > 0) {
      <nav class="breadcrumbs" aria-label="Breadcrumb">
        <ol
          class="breadcrumbs__list"
          itemscope
          itemtype="https://schema.org/BreadcrumbList"
        >
          @for (crumb of breadcrumbs(); track crumb.url; let idx = $index) {
            <li
              class="breadcrumbs__item"
              itemprop="itemListElement"
              itemscope
              itemtype="https://schema.org/ListItem"
            >
              @if (!crumb.isCurrent) {
                <a
                  class="breadcrumbs__link"
                  [routerLink]="crumb.url"
                  itemprop="item"
                >
                  <span itemprop="name">{{ crumb.label }}</span>
                </a>
                <span class="breadcrumbs__sep" aria-hidden="true">/</span>
              } @else {
                <span
                  class="breadcrumbs__current"
                  aria-current="page"
                  itemprop="item"
                >
                  <span itemprop="name">{{ crumb.label }}</span>
                </span>
              }
              <meta itemprop="position" [attr.content]="idx + 1" />
            </li>
          }
        </ol>
      </nav>
    }
  `,
  styles: [
    `
      .breadcrumbs {
        margin-bottom: 1rem;
        font-size: 0.875rem;
      }

      .breadcrumbs__list {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.375rem;
        list-style: none;
        margin: 0;
        padding: 0;
      }

      .breadcrumbs__item {
        display: inline-flex;
        align-items: center;
        gap: 0.375rem;
      }

      .breadcrumbs__link {
        color: #16a34a;
        text-decoration: none;
        font-weight: 500;
      }

      .breadcrumbs__link:hover,
      .breadcrumbs__link:focus-visible {
        text-decoration: underline;
      }

      .breadcrumbs__sep {
        color: #9ca3af;
        user-select: none;
      }

      .breadcrumbs__current {
        color: #4b5563;
        font-weight: 600;
      }
    `,
  ],
})
export class BreadcrumbsComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly activatedRoute = inject(ActivatedRoute);
  private readonly document = inject(DOCUMENT);

  readonly breadcrumbs = signal<BreadcrumbItem[]>([]);

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.rebuild();
      });
  }

  ngOnInit(): void {
    this.rebuild();
  }

  ngOnDestroy(): void {
    const script = this.document.getElementById(JSONLD_SCRIPT_ID);
    if (script?.parentNode) {
      script.parentNode.removeChild(script);
    }
  }

  private rebuild(): void {
    const items = this.buildFromSnapshot(this.activatedRoute.root.snapshot);
    this.breadcrumbs.set(items);
    this.syncJsonLd(items);
  }

  private buildFromSnapshot(root: ActivatedRouteSnapshot): BreadcrumbItem[] {
    const crumbs: BreadcrumbItem[] = [];
    let current: ActivatedRouteSnapshot | null = root;
    let urlAcc = '';

    while (current) {
      const segments = current.url.map((s) => s.path).filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i];
        urlAcc += `/${segment}`;

        const customLabel =
          i === segments.length - 1 && typeof current.data?.['breadcrumb'] === 'string'
            ? (current.data['breadcrumb'] as string)
            : undefined;

        crumbs.push({
          label: customLabel ?? this.formatSegment(segment, segments[i - 1], current),
          url: urlAcc,
          isCurrent: false,
        });
      }
      current = current.firstChild;
    }

    if (crumbs.length === 0) {
      return [];
    }

    // Prepend Home root if not already starting at dashboard
    if (crumbs[0].url !== '/dashboard') {
      crumbs.unshift({
        label: 'Home',
        url: '/dashboard',
        isCurrent: false,
      });
    }

    // Ensure intermediate parent link exists for detail routes like /credits/:id or /projects/:id
    // where /credits doesn't have its own list route.
    const normalized = crumbs.map((item, idx) => ({
      ...item,
      url: item.url === '/credits' ? '/dashboard' : item.url === '/certificates' ? '/dashboard' : item.url,
      isCurrent: idx === crumbs.length - 1,
    }));

    return normalized;
  }

  private formatSegment(
    segment: string,
    prevSegment: string | undefined,
    snapshot: ActivatedRouteSnapshot,
  ): string {
    const known = SEGMENT_LABELS[segment.toLowerCase()];
    if (known) return known;

    // Check if this segment corresponds to a route parameter (e.g. :id, :address)
    const paramValues = Object.values(snapshot.params ?? {});
    if (paramValues.includes(segment)) {
      if (segment.length > 14) {
        return `${segment.slice(0, 6)}…${segment.slice(-4)}`;
      }
      if (prevSegment === 'projects') return `Project #${segment}`;
      if (prevSegment === 'credits') return `Credit #${segment}`;
      if (prevSegment === 'certificates') return `Certificate #${segment}`;
      return `#${segment}`;
    }

    return segment
      .split('-')
      .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
      .join(' ');
  }

  private syncJsonLd(items: BreadcrumbItem[]): void {
    const head = this.document.head;
    if (!head) return;

    let script = this.document.getElementById(JSONLD_SCRIPT_ID) as HTMLScriptElement | null;
    if (items.length === 0) {
      if (script?.parentNode) {
        script.parentNode.removeChild(script);
      }
      return;
    }

    if (!script) {
      script = this.document.createElement('script');
      script.id = JSONLD_SCRIPT_ID;
      script.type = 'application/ld+json';
      head.appendChild(script);
    }

    const origin = this.document.location?.origin ?? '';
    const payload = {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: items.map((item, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        name: item.label,
        item: origin ? `${origin}${item.url}` : item.url,
      })),
    };

    script.textContent = JSON.stringify(payload);
  }
}
