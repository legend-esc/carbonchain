# Accessibility (WCAG) Compliance Guide

> Issue #549 — Documents the accessibility tooling, audit results, and ARIA
> fixes applied to the CarbonChain frontend.

---

## Tooling

| Tool | Purpose | When it runs |
|---|---|---|
| **Lighthouse CI** (`lighthouserc.js`) | Audit full pages for WCAG 2.1 AA compliance | Every PR via `ci.yml` frontend job |
| **axe-core** (`src/axe.config.js`) | Per-component zero-violation check in unit tests | `ng test` / `vitest` |

### CI gate

Lighthouse CI fails the build if the **accessibility score drops below 90**.
Zero critical or serious axe violations are required in component specs.

---

## Adding axe Tests to a Component Spec

```typescript
// Example: marketplace.component.spec.ts
import axe from 'axe-core';
import { axeConfig, categoriseViolations } from '../../axe.config';

it('should have no critical or serious accessibility violations', async () => {
  fixture.detectChanges();
  const results = await axe.run(fixture.nativeElement, axeConfig);
  const { critical, serious } = categoriseViolations(results.violations);
  expect(critical).toEqual([]);
  expect(serious).toEqual([]);
});
```

Install `axe-core` as a dev dependency (no version change needed — it is already
a transitive dependency of `@axe-core/playwright`):

```bash
npm install --save-dev axe-core
```

---

## ARIA Patterns Applied

### MarketplaceComponent (`marketplace.component.ts`)

The marketplace already includes:

| Element | ARIA attribute | Purpose |
|---|---|---|
| `<section class="filters">` | `aria-label="Filter marketplace listings"` | Landmark label for screen readers |
| `<table>` | `aria-label="Marketplace listings"` | Table purpose announced |
| `<th>` | `scope="col"` | Column headers associated with cells |
| `<div class="skeleton-wrapper">` | `aria-busy="true"` + `aria-label="Loading listings"` | Loading state announced |
| `<p class="error">` | `role="alert"` | Error announced immediately |
| `<nav class="pagination">` | `aria-label="Listings pagination"` | Navigation landmark |
| `<span class="page-info">` | `aria-live="polite"` | Page change announced without interruption |
| Buy `<button>` | `[attr.aria-label]="'Buy credit ' + offer.credit_id"` | Unique label per row |
| Buy `<button>` | `[attr.aria-busy]="buying() === offer.id"` | Spinner state announced |
| Filter `<button>` | `aria-label="Reset all filters"` | Descriptive label |
| All filter inputs | `aria-label="Filter by …"` | Inputs labelled beyond visible `<label>` for clarity |
| `<select>` / `<input>` filter fields | `id` + `for` pairing on `<label>` | Standard label association |

### Keyboard Navigation

All interactive elements (buttons, inputs, selects, links) are reachable and
operable via keyboard:

- `Tab` — move focus forward
- `Shift+Tab` — move focus backward
- `Space` / `Enter` — activate buttons
- `Arrow keys` — navigate `<select>` options

Focus-visible styles are applied via:

```css
.btn:focus-visible {
  outline: 2px solid #4caf50;
  outline-offset: 2px;
}
```

### Color Contrast

All text meets WCAG 2.1 AA contrast ratios:

- Normal text: ≥ 4.5 : 1
- Large text (≥ 18px regular / ≥ 14px bold): ≥ 3 : 1

Badge text/background pairs verified:
- `.badge-open`: `#2e7d32` on `#e8f5e9` — ratio ≥ 4.5 : 1 ✅
- `.badge-filled`: `#1565c0` on `#e3f2fd` — ratio ≥ 4.5 : 1 ✅
- `.badge-cancelled`: `#c62828` on `#fce4ec` — ratio ≥ 4.5 : 1 ✅

---

## Outstanding Items

The following items require further work as the app grows:

1. **Retirement wizard (`retire/`)** — confirm focus is moved to the first step on wizard open; trap focus within each modal/dialog step.
2. **Credit detail pages (`credits/`)** — verify data tables include `<caption>` or `aria-label`.
3. **Toast notifications** — verify `role="status"` or `role="alert"` is applied based on severity.
4. **Admin panel (`admin/`)** — audit form fields for label associations.
5. **Skip-to-content link** — add a visually-hidden "Skip to main content" link as the first focusable element in `index.html`.

---

## Running Lighthouse Locally

```bash
# Install LHCI
npm install -g @lhci/cli

# Build the frontend
cd frontend && npm run build

# Run Lighthouse audit
lhci autorun
```

## Running axe Locally

```bash
# Run all component tests (includes axe assertions)
cd frontend && npm run test:ci
```
