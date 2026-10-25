'use client';

import { forwardRef } from 'react';
import { LoaderCircle } from 'lucide-react';
import { trackPointer } from '../lib/liquid.mjs';

// danger dùng lại toàn bộ hiệu ứng của primary, chỉ đổi tông đỏ (globals.css .primary.danger).
const VARIANT_CLASS = { primary: 'primary', danger: 'primary danger', secondary: 'secondary', text: 'text-button' };

/**
 * Nút Liquid Glass (viên thuốc, nảy khi hover/bấm, dải sáng chéo chạy liên tục).
 *
 * @param {'primary'|'danger'|'secondary'|'text'} [variant='primary']  danger: hành động xoá/không hoàn tác
 * @param {'md'|'sm'} [size='md']
 * @param {boolean} [full]      chiếm hết chiều ngang
 * @param {boolean} [loading]   hiện spinner + khoá nút; `loadingText` thay nội dung khi đang chạy
 * @param {React.ReactNode} [icon] icon đứng trước nội dung (ẩn khi loading)
 */
const Button = forwardRef(function Button({
  variant = 'primary', size = 'md', full = false, loading = false, loadingText, icon,
  type = 'button', className = '', disabled, onPointerMove, children, ...props
}, ref) {
  const classes = [VARIANT_CLASS[variant] || VARIANT_CLASS.primary, size === 'sm' && 'btn-sm', full && 'full', className].filter(Boolean).join(' ');
  return <button
    ref={ref}
    type={type}
    className={classes}
    disabled={disabled || loading}
    aria-busy={loading || undefined}
    onPointerMove={event => { if (variant !== 'text') trackPointer(event); onPointerMove?.(event); }}
    {...props}
  >
    {loading ? <LoaderCircle className="icon spin" aria-hidden="true" /> : icon}
    {loading && loadingText ? loadingText : children}
  </button>;
});

export default Button;
