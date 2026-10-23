// Liquid glass: đặt toạ độ con trỏ (--mx/--my) lên phần tử để CSS vẽ vệt sáng đi theo.
// Gọi trong onPointerMove; bỏ qua cảm ứng (không có hover) để không tốn khung hình.
export function trackPointer(event) {
  if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--mx', `${event.clientX - rect.left}px`);
  el.style.setProperty('--my', `${event.clientY - rect.top}px`);
}
