// ---------------------------------------------------------------------------------------------
// A short note at the bottom of the screen that goes by itself (or when tapped), for "it's saved"
// moments that don't need a button press.
// ---------------------------------------------------------------------------------------------

export function showToast(text: string, ms = 4500): void {
  document.querySelectorAll('.toast').forEach((x) => x.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  const go = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.addEventListener('click', go);
  document.body.appendChild(el);
  setTimeout(go, ms);
}
