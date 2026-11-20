# Developer Guide: Resolving Common Accessibility (a11y) Issues

This guide provides practical instructions for CarbonChain developers to diagnose and fix common accessibility violations in the frontend Angular application to meet **WCAG 2.1 AA** standards.

---

## 1. Missing Accessible Names & Image Alt Text

### The Violation
Assistive technologies (screen readers) announce non-text elements (images, SVG icons, icon-only buttons) as unlabelled or confusing elements.

### How to Fix:
- **Images**: Always supply a descriptive `alt` attribute. If the image is purely decorative, specify `alt=""`.
  ```html
  <!-- Informative image -->
  <img src="assets/project-banner.png" alt="Amazon REDD+ reforestation site canopy" />

  <!-- Decorative image -->
  <img src="assets/leaf-icon.png" alt="" aria-hidden="true" />
  ```
- **Icon-only buttons**: If a button contains only an icon (e.g. close, delete, copy), provide an `aria-label`:
  ```html
  <!-- ❌ BAD -->
  <button (click)="remove()"><svg>...</svg></button>

  <!-- ✅ GOOD -->
  <button (click)="remove()" [attr.aria-label]="'Remove credit ' + credit.id">
    <svg aria-hidden="true">...</svg>
  </button>
  ```
- **SVG Elements**: Add `aria-hidden="true"` to decorative SVGs. For charts or standalone graphic illustrations, provide `role="img"` and `aria-label`:
  ```html
  <svg role="img" aria-label="Carbon credit retirement price trend chart">
    <desc>Monthly price average showing upward trend from 11 XLM to 13 XLM</desc>
    ...
  </svg>
  ```

---

## 2. Low Color Contrast

### The Violation
Text or interactive boundaries fail the WCAG 2.1 AA contrast requirements:
- **Normal text** (< 18px regular or < 14px bold): minimum contrast ratio **4.5 : 1** against background.
- **Large text** (≥ 18px regular or ≥ 14px bold): minimum contrast ratio **3.0 : 1**.
- **UI components and graphical objects** (input borders, active tab outlines): minimum **3.0 : 1**.

### How to Fix:
Use verified accessible color pairings from our design tokens:

| Element / State | Background | Text / Border | Contrast Ratio |
|---|---|---|---|
| Primary Button | `#2e7d32` | `#ffffff` | **5.3 : 1** ✅ |
| Danger Action | `#c62828` | `#ffffff` | **5.9 : 1** ✅ |
| Success Badge (`.badge-open`) | `#e8f5e9` | `#1b5e20` | **7.4 : 1** ✅ |
| Info Badge (`.badge-filled`) | `#e3f2fd` | `#0d47a1` | **8.6 : 1** ✅ |
| Warning Badge (`.badge-flagged`) | `#fff3e0` | `#b26a00` | **4.6 : 1** ✅ |

Avoid light gray text like `#999` or `#aaa` on white backgrounds; use `#595959` or darker.

---

## 3. Form Input Labels and Error Announcements

### The Violation
Inputs lack programmatic label association, or validation errors are presented visually without alerting screen reader users.

### How to Fix:
1. **Explicit Label Pairing**: Ensure every `<input>`, `<select>`, and `<textarea>` has a corresponding `<label>` with matching `for` and `id` attributes:
   ```html
   <!-- ✅ Explicit Association -->
   <label for="credit-tonnes">Retirement Tonnes</label>
   <input id="credit-tonnes" type="number" formControlName="tonnes" />
   ```
2. **Describing Errors**: Use `aria-invalid` and `aria-describedby` pointing to the error message container:
   ```html
   <input
     id="wallet-recipient"
     type="text"
     [attr.aria-invalid]="form.get('recipient')?.invalid && form.get('recipient')?.touched"
     aria-describedby="recipient-error"
   />
   @if (form.get('recipient')?.invalid && form.get('recipient')?.touched) {
     <span id="recipient-error" class="error-msg" role="alert">
       Please enter a valid 56-character Stellar public key.
     </span>
   }
   ```

---

## 4. Native Elements vs. Non-Semantic Divs

### The Violation
Using `<div (click)="...">` or `<span (click)="...">` instead of native `<button>` or `<a>`. Divs lack keyboard operability, role semantics, and focusability by default.

### How to Fix:
- **Buttons vs Links Rule**:
  - **Button (`<button>`)**: Triggers an action, submits data, opens a modal dialog, or changes page state.
  - **Link (`<a>`)**: Navigates to a new URL, external page, or on-page anchor.
- If a custom element MUST be used, provide:
  ```html
  <div
    role="button"
    tabindex="0"
    (click)="onActivate()"
    (keydown.enter)="onActivate()"
    (keydown.space)="onActivate(); $event.preventDefault()"
  >
    Custom Action
  </div>
  ```
  *(Recommendation: Prefer `<button type="button">` instead of simulating div buttons).*

---

## 5. Keyboard Navigation & Visible Focus

### The Violation
Outline removed with `outline: none` without providing an accessible alternative, leaving keyboard users unable to locate the focused element.

### How to Fix:
Ensure all interactive elements have prominent `:focus-visible` styles:
```css
/* ✅ Standard focus outline across components */
button:focus-visible,
input:focus-visible,
select:focus-visible,
a:focus-visible {
  outline: 2px solid #2e7d32;
  outline-offset: 2px;
}
```

Never use `outline: none;` without replacing it with an equivalent high-contrast focus indicator.

---

## 6. Live Regions and Status Alerts

### The Violation
Dynamic content changes (e.g. "Loading completed", "Transaction confirmed", "Error occurred") are not vocalized because they happen asynchronously without page reloads.

### How to Fix:
- **Status Updates (`role="status"`, `aria-live="polite"`)**: For non-disruptive feedback like search result counts or pagination changes:
  ```html
  <div role="status" aria-live="polite" class="sr-only">
    Showing {{ items.length }} credits for selected filter
  </div>
  ```
- **Critical Alerts (`role="alert"`, `aria-live="assertive"`)**: For errors requiring immediate attention (e.g., wallet rejection, network failure):
  ```html
  <div role="alert" class="alert-box">
    Transaction rejected: Insufficient XLM balance for transaction fee.
  </div>
  ```

---

## 7. Testing Accessibility Locally

Before pushing code or opening a PR, run the automated accessibility test suite:

```bash
# Run axe-core component accessibility suite
cd frontend && npm run a11y:audit

# Or run specific a11y test file
cd frontend && npx ng test --watch=false --include='**/a11y/*.spec.ts'
```

### Pre-PR Checklist:
- [ ] All inputs have associated `<label>` tags with matching `for` / `id`.
- [ ] All icon buttons have descriptive `aria-label` attributes.
- [ ] Decorative icons and graphics specify `aria-hidden="true"`.
- [ ] Focus rings are clearly visible via `:focus-visible`.
- [ ] Components pass `npm run a11y:audit` with **0 critical** and **0 serious** violations.
