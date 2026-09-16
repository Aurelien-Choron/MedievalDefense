/** A one-line message above the build menu that fades on its own. */

let timer = 0;

export function toast(message: string): void {
  const el = document.querySelector<HTMLElement>('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(timer);
  timer = window.setTimeout(() => el.classList.remove('show'), 1800);
}
