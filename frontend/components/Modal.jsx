'use client';

import { useEffect, useRef } from 'react';

/** <dialog> modal điều khiển bằng prop `open`; Esc/đóng gọi `onClose`. */
export default function Modal({ open, onClose, labelledBy, className = '', children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    else if (!open && dialog?.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`confirm-dialog ${className}`} aria-labelledby={labelledBy} onCancel={event => { event.preventDefault(); onClose(); }} onClose={() => { if (open) onClose(); }}>{children}</dialog>;
}
