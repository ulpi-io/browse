# Accessibility — ARIA, Keyboard, Focus, Reduced Motion

## What

Every interactive component must be usable by keyboard, screen reader, and assistive technology. The foundation is correct element choice — native HTML over ARIA. ARIA fills gaps where no native element fits. Focus management handles route transitions, mutations, and modal lifecycles. Reduced motion respects user preferences via Tailwind's `motion-reduce:` variant.

All visible strings use `t()`. All Tailwind uses logical properties. For RTL details see `references/i18n-conventions.md`.

## How

### ARIA patterns

Prefer native elements. Only add ARIA when no native element fits.

```tsx
// Icon-only button — aria-label required, icon hidden from screen reader
<button aria-label={t('common.close')} onClick={onClose}>
  <CloseIcon aria-hidden="true" />
</button>
// Disclosure — aria-expanded on trigger, aria-controls pointing to panel
<button aria-expanded={isOpen} aria-controls="faq-answer" onClick={toggle}>
  {t('faq.question')}
</button>
<div id="faq-answer" role="region" hidden={!isOpen}>{t('faq.answer')}</div>
// Dynamic region — screen reader announces updates
<div aria-live="polite" aria-atomic="true">
  {statusMessage && <p>{statusMessage}</p>}
</div>
// Form error — linked to input, announced immediately
<label htmlFor="email">{t('form.email')}</label>
<input id="email" aria-describedby="email-error" aria-invalid={!!error} />
{error && <p id="email-error" role="alert">{error}</p>}
```

- `aria-label` on every icon-only button — no visible text means no accessible name.
- `aria-expanded` on every disclosure trigger — accordion, dropdown, collapsible.
- `aria-live="polite"` on dynamic regions — toasts, form validation, loading states.
- `aria-describedby` linking error messages to inputs. `role="alert"` for immediate announcement.
- Decorative icons get `aria-hidden="true"`.

### Keyboard navigation

| Key | Action |
|-----|--------|
| Tab / Shift+Tab | Move focus forward / backward |
| Enter / Space | Activate button, toggle, link |
| Escape | Close modal, dropdown, popover |
| Arrow keys | Navigate within listbox, menu, tabs |

Custom elements must handle keyboard — but prefer `<button>` which needs zero ARIA:

```tsx
<div role="button" tabIndex={0} onClick={handleAction}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleAction(); }
  }}>
  {t('actions.select')}
</div>
```

Skip nav link — first focusable element in the layout. `tabIndex={-1}` on `<main>` allows programmatic focus without entering Tab order:

```tsx
<a href="#main-content"
  className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-background focus:px-4 focus:py-2">
  {t('common.skipToContent')}
</a>
<main id="main-content" tabIndex={-1}>{children}</main>
```

### Focus management

- **After route change**: focus moves to `<main>` or `<h1>`.
- **After mutation**: focus moves to success/error message.
- **After modal close**: focus returns to the trigger element.
- **After list item deletion**: focus the next item, not the top of the page.
- **Programmatic focus**: `useRef` + `ref.current?.focus()` — valid `'use client'` reason.

```tsx
'use client';
import { useRef } from 'react';
import { useTranslations } from 'next-intl';

export function ItemList({ items, onDelete }: ItemListProps) {
  const t = useTranslations('common');
  const nextItemRef = useRef<HTMLLIElement>(null);
  async function handleDelete(itemId: string) {
    await onDelete(itemId);
    nextItemRef.current?.focus();
  }
  return (
    <ul>
      {items.map((item, i) => (
        <li key={item.id} ref={i === 0 ? nextItemRef : undefined} tabIndex={-1}>
          <span>{item.name}</span>
          <button onClick={() => handleDelete(item.id)}>{t('button.delete')}</button>
        </li>
      ))}
    </ul>
  );
}
```

### Accessible modal — complete example

Focus trap, keyboard handling, ARIA, reduced motion, focus restoration — all via native `<dialog>`:

```tsx
'use client';
import { useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';

interface ModalProps {
  isOpen: boolean; onClose: () => void; title: string; children: React.ReactNode;
}
export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  const t = useTranslations('common');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (isOpen) {
      triggerRef.current = document.activeElement as HTMLElement;
      dialogRef.current?.showModal();
    } else {
      dialogRef.current?.close();
      triggerRef.current?.focus(); // Return focus to trigger
    }
  }, [isOpen]);

  const handleCancel = useCallback((e: React.SyntheticEvent) => {
    e.preventDefault(); onClose();
  }, [onClose]);
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === dialogRef.current) onClose();
  }, [onClose]);

  if (!isOpen) return null;
  return (
    <dialog ref={dialogRef} onCancel={handleCancel} onClick={handleBackdropClick}
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 m-auto rounded-lg bg-background p-0 shadow-xl
        backdrop:bg-black/50 motion-safe:animate-fade-in motion-reduce:animate-none">
      <div className="flex flex-col gap-4 p-6">
        <header className="flex items-center justify-between">
          <h2 id="modal-title" className="text-lg font-semibold">{title}</h2>
          <button aria-label={t('modal.close')} onClick={onClose}
            className="rounded-md p-1 hover:bg-muted focus-visible:outline-2
              focus-visible:outline-offset-2 focus-visible:outline-primary">
            <CloseIcon aria-hidden="true" />
          </button>
        </header>
        <div>{children}</div>
      </div>
    </dialog>
  );
}
```

Why `<dialog>` + `showModal()`: focus trap is native (Tab cycles within dialog). Escape closes via `onCancel`. `aria-modal="true"` set automatically. `motion-safe:animate-fade-in` plays only without reduced-motion preference. Focus captured in `triggerRef` on open, restored on close.

### Reduced motion

```tsx
<div className="motion-safe:transition-all motion-safe:duration-300 motion-reduce:transition-none">
  {content}
</div>
<svg className="motion-safe:animate-spin motion-reduce:animate-none" />
```

Every `animate-*` and `transition-*` must have a `motion-reduce:` counterpart. Cross-reference: `references/i18n-conventions.md` covers `prefers-reduced-motion` alongside RTL.

### Semantic HTML

```tsx
<a href="#main-content" className="sr-only focus:not-sr-only">{t('common.skipToContent')}</a>
<header><nav aria-label={t('nav.primary')}>{/* links */}</nav></header>
<main id="main-content" tabIndex={-1}>
  <h1>{t('products.heading')}</h1>           {/* One h1 per page */}
  <section aria-labelledby="featured">
    <h2 id="featured">{t('products.featured')}</h2>
    <ul><li>{/* product card */}</li></ul>    {/* Lists, not div chains */}
  </section>
  <aside aria-label={t('products.filters')}>{/* sidebar */}</aside>
</main>
<footer>{/* footer */}</footer>
```

- One `<h1>` per page via `t()`. Heading hierarchy: h1, h2, h3 — never skip levels.
- Landmarks: `<nav>`, `<main>`, `<aside>`, `<footer>`, `<section>`, `<article>`. Multiple `<nav>` get distinct `aria-label`.
- Lists use `<ul>`/`<ol>`. Form inputs always have associated `<label>` (visible or `sr-only`).

## When

| Situation | Pattern |
|-----------|---------|
| Icon-only button | `aria-label={t('...')}` + `aria-hidden` on icon |
| Toggle / disclosure | `aria-expanded` on trigger, `aria-controls` pointing to panel |
| Dynamic status (toast, loading) | `aria-live="polite"` wrapper |
| Form validation error | `aria-describedby` + `role="alert"` on error message |
| Modal / dialog | `<dialog>` + `showModal()` — native trap and Escape |
| Custom interactive widget | `role` + `tabIndex={0}` + `onKeyDown` (Enter/Space) |
| After route change | Focus `<main>` or `<h1>` |
| After modal close | Focus returns to trigger element |
| After list item deletion | Focus next item via `useRef` |
| Animation / transition | `motion-safe:` to play, `motion-reduce:transition-none` to disable |

## Never

- **No `<div onClick>` without keyboard handling.** Needs `role="button"`, `tabIndex={0}`, `onKeyDown` for Enter/Space. Prefer `<button>`.
- **No icon-only buttons without `aria-label`.** Invisible to assistive technology.
- **No `outline-none` without a visible focus alternative.** Use `focus-visible:outline-2 focus-visible:outline-primary`.
- **No color as the only indicator of state.** Red for errors needs an icon or `role="alert"`. Green for success needs a checkmark.
- **No `autoFocus` on page load.** Disorienting for screen readers. Only inside a newly opened modal (prefer `<dialog>` + `showModal()`).
- **No skipping heading levels.** h1 then h3 breaks screen reader navigation. Must be sequential.
- **No `<div>` chains for list content.** `<ul>`/`<ol>` — "list, 5 items" provides critical context.
- **No missing `<label>` on form inputs.** Placeholder is not a label. Use visible `<label>` or `sr-only`.
- **No animations without `motion-reduce:` counterpart.** Every `animate-*` / `transition-*` needs `motion-reduce:transition-none` or `motion-reduce:animate-none`.
